import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import {
  MAX_DIR_ENTRIES,
  MAX_DOWNLOAD_BYTES,
  MAX_EDIT_BYTES,
  MAX_REPOS,
  MAX_SEARCH_RESULTS,
  MAX_STATUS_FILES,
  WATCH_LEASE_MS,
  hostContract,
  hostSignals,
  type Change,
  type Commit,
  type CommitFile,
  type DirEntry,
  type RepoStatus,
  type Status,
} from "./contract.js";

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
const MAX_BUFFER = 64 * 1024 * 1024;
const PATCH_MAX_BYTES = 1024 * 1024;
const UNTRACKED_COUNT_MAX_FILES = 300;
const UNTRACKED_COUNT_MAX_BYTES = 512 * 1024;
const LS_FILES_TTL_MS = 5000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: GIT_ENV, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function gitOk(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await git(cwd, args, input);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.code}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function inside(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return target;
}

function relPaths(root: string, paths: readonly string[]): string[] {
  return paths.map((p) => path.relative(path.resolve(root), inside(root, p)));
}

const repoCache = new Map<string, boolean>();

async function isRepo(root: string): Promise<boolean> {
  const known = repoCache.get(root);
  if (known !== undefined) return known;
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  const repo = result !== null && result.code === 0 && result.stdout.trim() === "true";
  repoCache.set(root, repo);
  return repo;
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const TOPLEVEL_TTL_MS = 30_000;
const toplevelCache = new Map<string, { at: number; top: Promise<string | null> }>();

function toplevel(dir: string): Promise<string | null> {
  const cached = toplevelCache.get(dir);
  if (cached !== undefined && Date.now() - cached.at < TOPLEVEL_TTL_MS) return cached.top;
  const top = git(dir, ["rev-parse", "--show-toplevel"]).then(
    (result) => (result.code === 0 && result.stdout.trim() !== "" ? path.resolve(result.stdout.trim()) : null),
    () => null,
  );
  toplevelCache.set(dir, { at: Date.now(), top });
  return top;
}

async function listDir(root: string, rel: string) {
  const dir = inside(root, rel);
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const truncated = dirents.length > MAX_DIR_ENTRIES;
  const kept = dirents.filter((d) => d.name !== ".git").slice(0, MAX_DIR_ENTRIES);
  const entries: DirEntry[] = await Promise.all(
    kept.map(async (d) => {
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        isDir = await fs
          .stat(path.join(dir, d.name))
          .then((s) => s.isDirectory())
          .catch(() => false);
      }
      return { name: d.name, dir: isDir, ignored: false };
    }),
  );
  const top = entries.length > 0 ? await toplevel(dir) : null;
  if (top !== null) {
    const fromTop = path.relative(top, dir).split(path.sep).join("/");
    const prefix = fromTop === "" ? "" : `${fromTop}/`;
    const self = prefix === "" ? [] : [prefix];
    const input = [...self, ...entries.map((e) => `${prefix}${e.name}${e.dir ? "/" : ""}`)].join("\0");
    const result = await git(top, ["check-ignore", "-z", "--stdin"], `${input}\0`).catch(() => null);
    const insideIgnored =
      result !== null && prefix !== "" && result.stdout.split("\0").some((p) => p.replace(/\/$/u, "") === fromTop);
    if (result !== null && result.code !== 128 && !insideIgnored) {
      const ignored = new Set(
        result.stdout
          .split("\0")
          .filter(Boolean)
          .map((p) => p.replace(/\/$/u, "")),
      );
      await Promise.all(
        entries.map(async (entry) => {
          if (!ignored.has(`${prefix}${entry.name}`)) return;
          if (
            entry.dir &&
            (await fs.access(path.join(dir, entry.name, ".git")).then(
              () => true,
              () => false,
            ))
          )
            return;
          entry.ignored = true;
        }),
      );
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? COLLATOR.compare(a.name, b.name) : a.dir ? -1 : 1));
  return { entries, truncated };
}

function parseNumstat(out: string, into: Map<string, { add: number | null; del: number | null }>) {
  const parts = out.split("\0");
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (head === undefined || head === "") {
      i += 1;
      continue;
    }
    const [a, d, p] = head.split("\t");
    let file = p;
    if (file === "") {
      file = parts[i + 2];
      i += 3;
    } else {
      i += 1;
    }
    if (file === undefined || a === undefined || d === undefined) continue;
    const add = a === "-" ? null : Number(a);
    const del = d === "-" ? null : Number(d);
    const prev = into.get(file);
    into.set(file, {
      add: prev === undefined ? add : add === null || prev.add === null ? null : prev.add + add,
      del: prev === undefined ? del : del === null || prev.del === null ? null : prev.del + del,
    });
  }
}

async function countLines(file: string): Promise<number | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size > UNTRACKED_COUNT_MAX_BYTES) return null;
  const buffer = await fs.readFile(file);
  if (buffer.includes(0)) return null;
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 10) lines += 1;
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

async function status(root: string): Promise<Status> {
  if (!(await isRepo(root))) return { repo: false };
  const [porcelain, unstaged, staged] = await Promise.all([
    gitOk(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
    git(root, ["diff", "--numstat", "-z", "-M"]),
    git(root, ["diff", "--cached", "--numstat", "-z", "-M"]),
  ]);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: Change[] = [];
  let truncated = false;
  const parts = porcelain.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i];
    if (line === undefined || line === "") continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14);
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice(18);
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/u.exec(line);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (files.length >= MAX_STATUS_FILES) {
      truncated = true;
      if (line.startsWith("2 ")) i += 1;
    } else if (line.startsWith("1 ")) {
      const fields = line.split(" ");
      files.push(change(fields[1], fields.slice(8).join(" "), null));
    } else if (line.startsWith("2 ")) {
      const fields = line.split(" ");
      files.push(change(fields[1], fields.slice(9).join(" "), parts[i + 1] ?? null));
      i += 1;
    } else if (line.startsWith("u ")) {
      const fields = line.split(" ");
      files.push(change("UU", fields.slice(10).join(" "), null));
    } else if (line.startsWith("? ")) {
      files.push(change("??", line.slice(2), null));
    }
  }
  const stats = new Map<string, { add: number | null; del: number | null }>();
  if (unstaged.code === 0) parseNumstat(unstaged.stdout, stats);
  if (staged.code === 0) parseNumstat(staged.stdout, stats);
  let counted = 0;
  await Promise.all(
    files.map(async (file) => {
      if (file.x === "?") {
        if (counted >= UNTRACKED_COUNT_MAX_FILES) return;
        counted += 1;
        const lines = await countLines(path.join(root, file.path)).catch(() => null);
        file.add = lines;
        file.del = lines === null ? null : 0;
        return;
      }
      const stat = stats.get(file.path);
      if (stat !== undefined) {
        file.add = stat.add;
        file.del = stat.del;
      }
    }),
  );
  return { repo: true, branch, upstream, ahead, behind, files, truncated };
}

function change(xy: string | undefined, file: string, orig: string | null): Change {
  const code = xy ?? "..";
  return {
    path: file,
    orig,
    x: code[0] === "." ? " " : (code[0] ?? " "),
    y: code[1] === "." ? " " : (code[1] ?? " "),
    add: null,
    del: null,
  };
}

const lsFilesCache = new Map<string, { at: number; paths: Promise<string[]> }>();

function allFiles(root: string): Promise<string[]> {
  const cached = lsFilesCache.get(root);
  if (cached !== undefined && Date.now() - cached.at < LS_FILES_TTL_MS) return cached.paths;
  const paths = gitOk(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).then((out) => [
    ...new Set(out.split("\0").filter(Boolean)),
  ]);
  lsFilesCache.set(root, { at: Date.now(), paths });
  paths.catch(() => lsFilesCache.delete(root));
  return paths;
}

function fuzzyScore(candidate: string, query: string): number | null {
  const lower = candidate.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const baseIndex = base.indexOf(query);
  if (baseIndex !== -1) return baseIndex === 0 ? 0 : 1;
  if (lower.includes(query)) return 2;
  let at = 0;
  let gaps = 0;
  for (const ch of query) {
    const next = lower.indexOf(ch, at);
    if (next === -1) return null;
    gaps += next - at;
    at = next + 1;
  }
  return 3 + gaps / 100;
}

async function search(root: string, base: string, query: string) {
  const resolvedRoot = path.resolve(root);
  const dir = inside(root, base);
  const basePrefix = base === "" ? "" : `${base.replace(/\/+$/u, "")}/`;
  const tops = new Set<string>();
  const top = await toplevel(dir);
  if (top !== null) tops.add(top);
  const found = await discover(root, false).catch(() => ({ repos: [] as string[], truncated: false }));
  for (const repo of found.repos) {
    if (basePrefix === "" || repo === base || repo.startsWith(basePrefix)) tops.add(inside(root, repo));
  }
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ p: string; s: number }> = [];
  for (const t of tops) {
    const toWorkspace = path.relative(resolvedRoot, t).split(path.sep).join("/");
    const wsPrefix = toWorkspace === "" ? "" : `${toWorkspace}/`;
    const files = await allFiles(t).catch(() => [] as string[]);
    for (const p of files) {
      if (p.endsWith("/")) continue;
      const full = `${wsPrefix}${p}`;
      if (basePrefix !== "" && !full.startsWith(basePrefix)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      const s = fuzzyScore(full.slice(basePrefix.length), needle);
      if (s !== null) scored.push({ p: full, s });
    }
  }
  scored.sort((a, b) => a.s - b.s || a.p.length - b.p.length || COLLATOR.compare(a.p, b.p));
  return { paths: scored.slice(0, MAX_SEARCH_RESULTS).map((e) => e.p) };
}

async function untrackedPatch(root: string, rel: string) {
  const file = inside(root, rel);
  const stat = await fs.stat(file);
  if (stat.size > PATCH_MAX_BYTES) return { patch: "", truncated: true };
  const buffer = await fs.readFile(file);
  if (buffer.includes(0)) return { patch: "", truncated: true };
  const text = buffer.toString("utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (text === "") return { patch: "", truncated: false };
  const body = lines.map((l) => `+${l}`).join("\n");
  const noEol = text.endsWith("\n") ? "" : "\n\\ No newline at end of file";
  return {
    patch: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}${noEol}\n`,
    truncated: false,
  };
}

async function diff(root: string, rel: string, staged: boolean, untracked: boolean) {
  const [safe] = relPaths(root, [rel]);
  if (safe === undefined) throw new Error("Missing path");
  if (untracked) return untrackedPatch(root, safe);
  const args = ["diff", "--no-color", "--no-ext-diff", "-M"];
  if (staged) args.push("--cached");
  const out = await gitOk(root, [...args, "--", safe]);
  if (Buffer.byteLength(out) > PATCH_MAX_BYTES) return { patch: "", truncated: true };
  return { patch: out === "" ? "" : `${out}\n`, truncated: false };
}

function invalidate(_root: string) {
  lsFilesCache.clear();
}

const DISCOVERY_MAX_DEPTH = 4;
const DISCOVERY_MAX_DIRS = 6000;
const DISCOVERY_TTL_MS = 30_000;
const STATUS_CONCURRENCY = 6;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  ".pnpm-store",
  ".gradle",
  ".idea",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "venv",
  "__pycache__",
  "coverage",
]);

const discoveryCache = new Map<string, { at: number; result: Promise<{ repos: string[]; truncated: boolean }> }>();

function discover(root: string, rescan: boolean) {
  const key = root;
  const cached = discoveryCache.get(key);
  if (!rescan && cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.result;
  const result = walkForRepos(root);
  discoveryCache.set(key, { at: Date.now(), result });
  result.catch(() => discoveryCache.delete(key));
  return result;
}

async function walkForRepos(root: string) {
  const repos: string[] = [];
  let truncated = false;
  let visited = 0;
  let level: Array<{ abs: string; rel: string }> = [{ abs: path.resolve(root), rel: "" }];
  for (let depth = 0; level.length > 0 && !truncated; depth += 1) {
    const next: Array<{ abs: string; rel: string }> = [];
    const listed = await Promise.all(
      level.map(async (dir) => ({
        dir,
        dirents: await fs.readdir(dir.abs, { withFileTypes: true }).catch(() => []),
      })),
    );
    for (const { dir, dirents } of listed) {
      visited += 1;
      if (dirents.some((d) => d.name === ".git")) {
        repos.push(dir.rel);
        if (repos.length >= MAX_REPOS) {
          truncated = true;
          break;
        }
      }
      if (depth >= DISCOVERY_MAX_DEPTH) continue;
      for (const d of dirents) {
        if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
        next.push({ abs: path.join(dir.abs, d.name), rel: dir.rel === "" ? d.name : `${dir.rel}/${d.name}` });
      }
    }
    if (visited + next.length > DISCOVERY_MAX_DIRS) {
      truncated = true;
      level = next.slice(0, Math.max(0, DISCOVERY_MAX_DIRS - visited));
    } else {
      level = next;
    }
  }
  repos.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : COLLATOR.compare(a, b)));
  return { repos, truncated };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        out[index] = await run(items[index] as T);
      }
    }),
  );
  return out;
}

async function workspaceStatus(root: string, rescan: boolean) {
  const found = await discover(root, rescan);
  const repos: RepoStatus[] = await mapLimit(found.repos, STATUS_CONCURRENCY, async (repo) => {
    const repoRoot = inside(root, repo);
    repoCache.set(repoRoot, true);
    const result = await status(repoRoot).catch((): Status => ({ repo: false }));
    return { repo, status: result };
  });
  const all = found.repos;
  for (const entry of repos) {
    if (!entry.status.repo) continue;
    const prefix = entry.repo === "" ? "" : `${entry.repo}/`;
    const nested = all
      .filter((other) => other !== entry.repo && other.startsWith(prefix))
      .map((other) => other.slice(prefix.length));
    if (nested.length === 0) continue;
    entry.status.files = entry.status.files.filter((file) => {
      const p = file.path.replace(/\/+$/u, "");
      return !nested.some((n) => p === n || p.startsWith(`${n}/`) || n.startsWith(`${p}/`));
    });
  }
  return {
    name: path.basename(path.resolve(root)),
    root: path.resolve(root),
    repos: repos.filter((r) => r.status.repo),
    truncated: found.truncated,
  };
}

const FIELD = "\x1f";
const RECORD = "\x1e";
const SHOW_MAX_FILES = 300;
const SHOW_FILE_MAX_BYTES = 512 * 1024;
const SHOW_TOTAL_MAX_BYTES = 6 * 1024 * 1024;

async function log(repoRoot: string, all: boolean, skip: number, limit: number) {
  const args = [
    "log",
    "--topo-order",
    "--decorate=full",
    `--skip=${skip}`,
    `--max-count=${limit + 1}`,
    `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%D${FIELD}%s${RECORD}`,
  ];
  if (all) args.push("--branches", "--remotes", "--tags", "HEAD");
  else args.push("HEAD");
  const result = await git(repoRoot, args);
  if (result.code !== 0) return { commits: [], hasMore: false };
  const commits: Commit[] = [];
  for (const record of result.stdout.split(RECORD)) {
    const line = record.replace(/^\n/u, "");
    if (line === "") continue;
    const [sha, parents, author, email, time, refs, subject] = line.split(FIELD);
    if (sha === undefined || sha === "") continue;
    commits.push({
      sha,
      parents: parents === undefined || parents === "" ? [] : parents.split(" "),
      author: author ?? "",
      email: email ?? "",
      time: Number(time ?? 0),
      refs: refs ?? "",
      subject: subject ?? "",
    });
  }
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

async function show(repoRoot: string, sha: string) {
  const header = await gitOk(repoRoot, [
    "show",
    "-s",
    `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${FIELD}%b`,
    sha,
  ]);
  const [full, parents, author, email, time, subject, ...body] = header.split(FIELD);
  const firstParent = (parents ?? "").split(" ").filter(Boolean)[0];
  const range = firstParent === undefined ? ["--root", sha] : [firstParent, sha];
  const [numstat, patch] = await Promise.all([
    git(repoRoot, ["diff-tree", "-r", "-M", "--numstat", "-z", "--no-commit-id", ...range]),
    git(repoRoot, ["diff-tree", "-r", "-M", "-p", "--no-color", "--no-ext-diff", "--no-commit-id", ...range]),
  ]);
  const stats = new Map<string, { add: number | null; del: number | null }>();
  if (numstat.code === 0) parseNumstat(numstat.stdout, stats);
  const files: CommitFile[] = [];
  let total = 0;
  let truncated = false;
  const chunks = patch.code === 0 ? patch.stdout.split(/^(?=diff --git )/mu) : [];
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git ")) continue;
    if (files.length >= SHOW_MAX_FILES) {
      truncated = true;
      break;
    }
    const plus = /^\+\+\+ b\/(.+)$/mu.exec(chunk)?.[1];
    const renamed = /^rename to (.+)$/mu.exec(chunk)?.[1];
    const minus = /^--- a\/(.+)$/mu.exec(chunk)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(chunk);
    const filePath = plus ?? renamed ?? minus ?? header?.[2] ?? "?";
    const size = Buffer.byteLength(chunk);
    const tooBig = size > SHOW_FILE_MAX_BYTES || total + size > SHOW_TOTAL_MAX_BYTES;
    if (!tooBig) total += size;
    const stat = stats.get(filePath);
    files.push({
      path: filePath,
      patch: tooBig ? "" : chunk,
      add: stat?.add ?? null,
      del: stat?.del ?? null,
      truncated: tooBig,
    });
  }
  return {
    sha: full ?? sha,
    parents: (parents ?? "").split(" ").filter(Boolean),
    author: author ?? "",
    email: email ?? "",
    time: Number(time ?? 0),
    subject: subject ?? "",
    body: body.join(FIELD).trim(),
    files,
    truncated,
  };
}

const WATCH_IGNORES = [
  "**/node_modules",
  "**/.git/objects",
  "**/.git/logs",
  "**/.git/lfs",
  "**/.git/hooks",
  "**/.git/modules/*/objects",
  "**/dist",
  "**/build",
  "**/.next",
  "**/.nuxt",
  "**/.turbo",
  "**/.cache",
  "**/.venv",
  "**/venv",
  "**/__pycache__",
  "**/target",
  "**/coverage",
  "**/.pnpm-store",
  "**/.gradle",
];

function isNoise(changed: string): boolean {
  return (
    changed.endsWith(".lock") ||
    changed.includes(`${path.sep}.git${path.sep}objects${path.sep}`) ||
    changed.includes(`${path.sep}.git${path.sep}logs${path.sep}`) ||
    changed.endsWith(`${path.sep}.git${path.sep}FETCH_HEAD`)
  );
}

interface WatchState {
  expires: number;
  watching: boolean;
  dispose: (() => Promise<void>) | null;
  gitDirs: Map<string, () => Promise<void>>;
}

const GIT_DIR_IGNORES = ["objects", "logs", "lfs", "hooks", "modules/*/objects", "worktrees/*/logs"];

async function gitDirsFor(root: string): Promise<string[]> {
  const found = await discover(root, false).catch(() => ({ repos: [] as string[], truncated: false }));
  const dirs = new Set<string>();
  await Promise.all(
    found.repos.map(async (repo) => {
      const result = await git(inside(root, repo), ["rev-parse", "--absolute-git-dir", "--git-common-dir"]).catch(
        () => null,
      );
      if (result === null || result.code !== 0) return;
      const [gitDir, common] = result.stdout.trim().split("\n");
      if (gitDir !== undefined && gitDir !== "") dirs.add(path.resolve(gitDir));
      if (common !== undefined && common !== "") dirs.add(path.resolve(inside(root, repo), common));
    }),
  );
  return [...dirs];
}

async function syncGitDirWatches(key: string, state: WatchState, context: HostContext, emit: () => void) {
  const wanted = new Set(await gitDirsFor(key));
  for (const [dir, dispose] of state.gitDirs) {
    if (wanted.has(dir)) continue;
    state.gitDirs.delete(dir);
    void dispose().catch(() => undefined);
  }
  await Promise.all(
    [...wanted].map(async (dir) => {
      if (state.gitDirs.has(dir) || !watches.has(key)) return;
      try {
        const subscription = await context.experimental_watch(
          { rootPath: dir, ignoredPaths: GIT_DIR_IGNORES, debounceMs: 150, maxWaitMs: 1000 },
          (event) => {
            if (event.kind === "watch-error") return;
            if (event.kind === "changed" && event.changes.every((change) => isNoise(change.path))) return;
            emit();
          },
        );
        state.gitDirs.set(dir, () => subscription.dispose());
      } catch {
        return;
      }
    }),
  );
}

const watches = new Map<string, WatchState>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep() {
  const now = Date.now();
  for (const [key, state] of watches) {
    if (state.expires > now) continue;
    watches.delete(key);
    void state.dispose?.().catch(() => undefined);
    for (const dispose of state.gitDirs.values()) void dispose().catch(() => undefined);
  }
  if (watches.size === 0 && sweeper !== null) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;

async function watch(root: string, context: HostContext): Promise<{ watching: boolean }> {
  const key = path.resolve(root);
  const expires = Date.now() + WATCH_LEASE_MS;
  const existing = watches.get(key);
  const emit = () => void context.experimental_emitSignal("changed", { root: key }).catch(() => undefined);
  if (existing !== undefined) {
    existing.expires = expires;
    void syncGitDirWatches(key, existing, context, emit);
    return { watching: existing.watching };
  }
  const state: WatchState = { expires, watching: false, dispose: null, gitDirs: new Map() };
  watches.set(key, state);
  if (sweeper === null) {
    sweeper = setInterval(sweep, 30_000);
    sweeper.unref?.();
  }
  try {
    const subscription = await context.experimental_watch(
      { rootPath: key, ignoredPaths: WATCH_IGNORES, debounceMs: 150, maxWaitMs: 1000 },
      (event) => {
        if (event.kind === "watch-error") return;
        if (event.kind === "changed" && event.changes.every((change) => isNoise(change.path))) return;
        if (event.kind === "changed" && event.changes.some((change) => change.path.endsWith(`${path.sep}.git`))) {
          discoveryCache.delete(key);
          void syncGitDirWatches(key, state, context, emit);
        }
        emit();
      },
    );
    state.watching = true;
    state.dispose = () => subscription.dispose();
    await syncGitDirWatches(key, state, context, emit);
  } catch {
    state.watching = false;
  }
  return { watching: state.watching };
}

const MAX_BRANCHES = 1000;
const COMPARE_MAX_FILES = 3000;

async function branches(repoRoot: string) {
  const [current, originHead, refs] = await Promise.all([
    git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    git(repoRoot, [
      "for-each-ref",
      "--sort=-committerdate",
      `--count=${MAX_BRANCHES}`,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ]),
  ]);
  const list: Array<{ name: string; remote: boolean }> = [];
  for (const ref of refs.stdout.split("\n")) {
    if (ref.startsWith("refs/heads/")) list.push({ name: ref.slice(11), remote: false });
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
      list.push({ name: ref.slice(13), remote: true });
  }
  const names = new Set(list.map((b) => b.name));
  const currentName = current.code === 0 ? current.stdout.trim() : null;
  const candidates = [
    originHead.code === 0 ? originHead.stdout.trim() : "",
    "main",
    "master",
    "origin/main",
    "origin/master",
    "develop",
  ];
  const defaultBase = candidates.find((c) => c !== "" && names.has(c) && c !== currentName) ?? null;
  return { current: currentName, defaultBase, branches: list };
}

const STATUS_LETTERS = new Set(["A", "M", "D", "R", "C", "T"]);

async function compare(repoRoot: string, base: string) {
  const mergeBase = await git(repoRoot, ["merge-base", base, "HEAD"]);
  if (mergeBase.code !== 0) {
    return { base, found: false, ahead: 0, behind: 0, files: [], truncated: false };
  }
  const mb = mergeBase.stdout.trim();
  const [counts, nameStatus, numstat] = await Promise.all([
    git(repoRoot, ["rev-list", "--left-right", "--count", `${base}...HEAD`]),
    git(repoRoot, ["diff", "--name-status", "-z", "-M", mb, "HEAD"]),
    git(repoRoot, ["diff", "--numstat", "-z", "-M", mb, "HEAD"]),
  ]);
  const [behind, ahead] = counts.stdout.trim().split(/\s+/u).map(Number);
  const stats = new Map<string, { add: number | null; del: number | null }>();
  if (numstat.code === 0) parseNumstat(numstat.stdout, stats);
  const files: Array<{
    path: string;
    orig: string | null;
    status: "A" | "M" | "D" | "R" | "C" | "T";
    add: number | null;
    del: number | null;
  }> = [];
  let truncated = false;
  const parts = nameStatus.stdout.split("\0");
  for (let i = 0; i < parts.length;) {
    const code = parts[i];
    if (code === undefined || code === "") {
      i += 1;
      continue;
    }
    const letter = code[0] ?? "M";
    const renamed = letter === "R" || letter === "C";
    const first = parts[i + 1] ?? "";
    const second = renamed ? (parts[i + 2] ?? "") : null;
    i += renamed ? 3 : 2;
    if (files.length >= COMPARE_MAX_FILES) {
      truncated = true;
      break;
    }
    const filePath = second ?? first;
    const stat = stats.get(filePath);
    files.push({
      path: filePath,
      orig: renamed ? first : null,
      status: (STATUS_LETTERS.has(letter) ? letter : "M") as "A" | "M" | "D" | "R" | "C" | "T",
      add: stat?.add ?? null,
      del: stat?.del ?? null,
    });
  }
  return { base, found: true, ahead: ahead ?? 0, behind: behind ?? 0, files, truncated };
}

async function compareDiff(repoRoot: string, base: string, rel: string) {
  const [safe] = relPaths(repoRoot, [rel]);
  if (safe === undefined) throw new Error("Missing path");
  const out = await gitOk(repoRoot, ["diff", "--no-color", "--no-ext-diff", "-M", `${base}...HEAD`, "--", safe]);
  if (Buffer.byteLength(out) > PATCH_MAX_BYTES) return { patch: "", truncated: true };
  return { patch: out === "" ? "" : `${out}\n`, truncated: false };
}

export function webRepoUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
  const scp = /^[^@/]+@([^:/]+):(.+)$/u.exec(trimmed);
  if (scp !== null) return `https://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    const pathName = parsed.pathname.replace(/^\/+/u, "");
    if (pathName === "") return null;
    return `https://${parsed.hostname}/${pathName}`;
  } catch {
    return null;
  }
}

export function pullRequestUrl(webUrl: string, head: string, base: string): string {
  const host = new URL(webUrl).hostname;
  const enc = encodeURIComponent;
  if (host.includes("gitlab")) {
    return `${webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(head)}&merge_request%5Btarget_branch%5D=${enc(base)}`;
  }
  if (host.includes("bitbucket")) {
    return `${webUrl}/pull-requests/new?source=${enc(head)}&dest=${enc(base)}`;
  }
  return `${webUrl}/compare/${base.split("/").map(enc).join("/")}...${head.split("/").map(enc).join("/")}?expand=1`;
}

async function createPr(repoRoot: string, base: string) {
  const branch = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0) throw new Error("HEAD is detached; check out a branch first.");
  const head = branch.stdout.trim();
  const upstream = await git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  let remote = upstream.code === 0 ? (upstream.stdout.trim().split("/")[0] ?? "origin") : null;
  let pushed = false;
  if (remote === null) {
    await gitOk(repoRoot, ["push", "-u", "origin", "HEAD"]);
    remote = "origin";
    pushed = true;
  } else {
    const ahead = await git(repoRoot, ["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) {
      await gitOk(repoRoot, ["push"]);
      pushed = true;
    }
  }
  const remoteUrl = await git(repoRoot, ["remote", "get-url", remote]);
  const web = remoteUrl.code === 0 ? webRepoUrl(remoteUrl.stdout) : null;
  const remotes = await git(repoRoot, ["remote"]);
  const baseBranch = remotes.stdout
    .split("\n")
    .filter(Boolean)
    .reduce((name, r) => (name.startsWith(`${r}/`) ? name.slice(r.length + 1) : name), base);
  return { url: web === null ? null : pullRequestUrl(web, head, baseBranch), pushed, remote: web };
}

async function applyHunk(repoRoot: string, patch: string, mode: "stage" | "unstage" | "discard") {
  if (!patch.startsWith("diff --git ") && !patch.startsWith("--- ")) throw new Error("Not a patch.");
  const args =
    mode === "stage"
      ? ["apply", "--cached", "--recount", "-"]
      : mode === "unstage"
        ? ["apply", "--cached", "--recount", "-R", "-"]
        : ["apply", "--recount", "-R", "-"];
  const body = patch.endsWith("\n") ? patch : `${patch}\n`;
  return { output: await gitOk(repoRoot, args, body) };
}

const COMMIT_PATCH_MAX_BYTES = 120 * 1024;

async function commitContext(repoRoot: string) {
  const cached = await git(repoRoot, ["diff", "--cached", "--quiet"]);
  const stagedOnly = cached.code === 1;
  const diffArgs = stagedOnly ? ["diff", "--cached"] : ["diff", "HEAD"];
  const [stat, patch, untracked, recent, branch] = await Promise.all([
    git(repoRoot, [...diffArgs, "--stat", "--no-color"]),
    git(repoRoot, [...diffArgs, "--no-color", "--no-ext-diff", "-M"]),
    stagedOnly ? null : git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(repoRoot, ["log", "-n", "10", "--format=%s"]),
    git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  let text = patch.code === 0 ? patch.stdout : "";
  const newFiles = untracked === null ? [] : untracked.stdout.split("\0").filter((f) => f !== "" && !f.endsWith("/"));
  for (const file of newFiles.slice(0, 50)) {
    if (Buffer.byteLength(text) > COMMIT_PATCH_MAX_BYTES) break;
    const added = await untrackedPatch(repoRoot, file).catch(() => null);
    if (added !== null && !added.truncated) text += `diff --git a/${file} b/${file}\nnew file\n${added.patch}`;
  }
  const truncated = Buffer.byteLength(text) > COMMIT_PATCH_MAX_BYTES;
  if (truncated) text = Buffer.from(text).subarray(0, COMMIT_PATCH_MAX_BYTES).toString("utf8");
  const statText = [stat.code === 0 ? stat.stdout.trim() : "", ...newFiles.map((f) => ` ${f} (new file)`)]
    .filter(Boolean)
    .join("\n");
  return {
    stagedOnly,
    stat: statText,
    patch: text,
    truncated,
    recent: recent.code === 0 ? recent.stdout.split("\n").filter(Boolean) : [],
    branch: branch.code === 0 ? branch.stdout.trim() : null,
  };
}

function runClaudeCli(cwd: string, prompt: string): Promise<{ available: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", "claude-opus-5-5", "--tools", ""],
      { cwd, env: process.env, maxBuffer: 4 * 1024 * 1024, timeout: 90_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null && "code" in error && error.code === "ENOENT") {
          resolve({ available: false, text: "" });
          return;
        }
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve({ available: true, text: stdout.trim() });
      },
    );
    child.stdin?.end(prompt);
  });
}

function entryTarget(root: string, rel: string): string {
  const target = inside(root, rel);
  if (target === path.resolve(root)) throw new Error("This action needs a file or folder inside the workspace.");
  if (rel.split(/[\\/]/u).includes(".git")) throw new Error("Treehouse does not change files inside .git.");
  return target;
}

function toRel(root: string, target: string): string {
  return path.relative(path.resolve(root), target).split(path.sep).join("/");
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

async function createEntry(root: string, parent: string, name: string, dir: boolean) {
  const parentDir = inside(root, parent);
  const target = path.join(parentDir, name);
  entryTarget(root, toRel(root, target));
  if (await exists(target)) throw new Error(`${name} already exists.`);
  if (dir) {
    await fs.mkdir(target);
  } else {
    await fs.writeFile(target, "", { flag: "wx" });
  }
  return { path: toRel(root, target) };
}

async function renameEntry(root: string, rel: string, name: string) {
  const from = entryTarget(root, rel);
  const to = path.join(path.dirname(from), name);
  entryTarget(root, toRel(root, to));
  if (to === from) return { path: rel };
  const caseOnly = to.toLowerCase() === from.toLowerCase();
  if (!caseOnly && (await exists(to))) throw new Error(`${name} already exists.`);
  await fs.rename(from, to);
  return { path: toRel(root, to) };
}

function hashOf(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

async function readText(root: string, rel: string) {
  const target = entryTarget(root, rel);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new Error(`${rel} is a folder.`);
  if (stat.size > MAX_EDIT_BYTES) return { kind: "too-large" as const, size: stat.size };
  const bytes = await fs.readFile(target);
  if (bytes.subarray(0, 8000).includes(0)) return { kind: "binary" as const };
  return { kind: "text" as const, content: bytes.toString("utf8"), hash: hashOf(bytes) };
}

async function writeText(root: string, rel: string, content: string, expectedHash: string | null) {
  const target = entryTarget(root, rel);
  const current = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const currentHash = current === null ? null : hashOf(current);
  if (expectedHash !== null && currentHash !== expectedHash) return { kind: "conflict" as const, hash: currentHash };
  const bytes = Buffer.from(content, "utf8");
  // Write beside the file and rename over it so a crash never leaves it half written.
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.treehouse-${process.pid}-${Date.now()}`);
  const mode = await fs.stat(target).then(
    (s) => s.mode,
    () => undefined,
  );
  await fs.writeFile(temp, bytes, mode === undefined ? undefined : { mode });
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return { kind: "saved" as const, hash: hashOf(bytes) };
}

async function moveEntry(root: string, rel: string, toDirRel: string) {
  const from = entryTarget(root, rel);
  const toDir = inside(root, toDirRel);
  if (toDirRel.split(/[\\/]/u).includes(".git")) throw new Error("Treehouse does not change files inside .git.");
  if (!(await fs.stat(toDir)).isDirectory()) throw new Error(`${toDirRel} is not a folder.`);
  if (toDir === from || toDir.startsWith(from + path.sep)) throw new Error("A folder can't be moved into itself.");
  const name = path.basename(from);
  const to = path.join(toDir, name);
  if (to === from) return { path: rel };
  if (await exists(to)) throw new Error(`${toDirRel === "" ? "The workspace root" : toDirRel} already has ${name}.`);
  await moveAcross(from, to);
  return { path: toRel(root, to) };
}

export function duplicateName(name: string, dir: boolean, n: number): string {
  const suffix = n === 1 ? " copy" : ` copy ${n}`;
  const dot = dir ? -1 : name.lastIndexOf(".");
  if (dot <= 0) return `${name}${suffix}`;
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}

async function duplicateEntry(root: string, rel: string) {
  const from = entryTarget(root, rel);
  const stat = await fs.stat(from);
  const name = path.basename(from);
  for (let n = 1; n < 1000; n += 1) {
    const to = path.join(path.dirname(from), duplicateName(name, stat.isDirectory(), n));
    if (await exists(to)) continue;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    return { path: toRel(root, to) };
  }
  throw new Error(`Could not find a free name for a copy of ${name}.`);
}

async function deleteEntry(root: string, rel: string, permanent: boolean) {
  const target = entryTarget(root, rel);
  if (permanent) {
    await fs.rm(target, { recursive: true, force: false });
    return { path: rel, trashed: false };
  }
  await fs.lstat(target);
  await moveToTrash(target);
  return { path: rel, trashed: true };
}

/** Runs a command; true when it exits 0, false when it is missing or fails. */
function succeeds(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 60_000, env: env ?? process.env }, (error) => resolve(error === null));
  });
}

async function uniqueIn(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = n === 1 ? name : `${stem}.${n}${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error(`The trash already holds too many items named ${name}.`);
}

async function moveAcross(from: string, to: string) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/** Moves a file or folder into a freedesktop.org trash directory, as file managers do. */
export async function xdgTrash(target: string, trashDir: string): Promise<string> {
  const filesDir = path.join(trashDir, "files");
  const infoDir = path.join(trashDir, "info");
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(infoDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = await uniqueIn(filesDir, path.basename(target));
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const encoded = target.split("/").map(encodeURIComponent).join("/");
    try {
      await fs.writeFile(
        path.join(infoDir, `${name}.trashinfo`),
        `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}\n`,
        {
          flag: "wx",
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await moveAcross(target, path.join(filesDir, name));
    } catch (error) {
      await fs.rm(path.join(infoDir, `${name}.trashinfo`), { force: true });
      throw error;
    }
    return path.join(filesDir, name);
  }
  throw new Error("Could not reserve a name in the trash.");
}

async function moveToTrash(target: string) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "darwin") {
    if (await succeeds("trash", [target])) return;
    const script = 'on run argv\ntell application "Finder" to delete (POSIX file (item 1 of argv))\nend run';
    if (await succeeds("osascript", ["-e", script, target])) return;
    const trash = path.join(home, ".Trash");
    await moveAcross(target, path.join(trash, await uniqueIn(trash, path.basename(target))));
    return;
  }
  if (process.platform === "win32") {
    const command = [
      "Add-Type -AssemblyName Microsoft.VisualBasic;",
      "$p = $env:TREEHOUSE_TRASH_PATH;",
      "if (Test-Path -LiteralPath $p -PathType Container) {",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
      "} else {",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
      "}",
    ].join(" ");
    const env = { ...process.env, TREEHOUSE_TRASH_PATH: target };
    if (await succeeds("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], env)) return;
    throw new Error("Could not move it to the Recycle Bin.");
  }
  if (await succeeds("gio", ["trash", "--", target])) return;
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  await xdgTrash(target, path.join(dataHome, "Trash"));
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

const TOO_BIG = `Downloads are limited to ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`;

async function readEntry(root: string, rel: string) {
  const target = entryTarget(root, rel);
  const stat = await fs.stat(target);
  const name = path.basename(target);
  if (!stat.isDirectory()) {
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error(TOO_BIG);
    const bytes = await fs.readFile(target);
    const mime = MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    return { fileName: name, base64: bytes.toString("base64"), mime };
  }
  const archive = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "tar",
      ["-czf", "-", "-C", path.dirname(target), "--", name],
      { encoding: "buffer", maxBuffer: MAX_DOWNLOAD_BYTES, timeout: 120_000 },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new Error(TOO_BIG));
        else reject(new Error(`Could not archive ${name}: ${error.message}`));
      },
    );
  });
  return { fileName: `${name}.tar.gz`, base64: archive.toString("base64"), mime: "application/gzip" };
}

async function revealEntry(root: string, rel: string) {
  const target = inside(root, rel);
  const isDir = await fs.stat(target).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const [command, args] =
    process.platform === "darwin"
      ? ["open", isDir ? [target] : ["-R", target]]
      : process.platform === "win32"
        ? ["explorer", isDir ? [target] : [`/select,${target}`]]
        : ["xdg-open", [isDir ? target : path.dirname(target)]];
  return new Promise<{ opened: boolean }>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve({ opened: false }));
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true });
    });
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  dispose: () => {
    repoCache.clear();
    lsFilesCache.clear();
    discoveryCache.clear();
    toplevelCache.clear();
    if (sweeper !== null) clearInterval(sweeper);
    sweeper = null;
    const active = [...watches.values()];
    watches.clear();
    return Promise.all(
      active.flatMap((state) => [
        state.dispose?.().catch(() => undefined),
        ...[...state.gitDirs.values()].map((dispose) => dispose().catch(() => undefined)),
      ]),
    ).then(() => undefined);
  },
  handlers: {
    listDir: ({ root, rel }) => listDir(root, rel),
    workspaceStatus: ({ root, rescan }) => workspaceStatus(root, rescan),
    search: ({ root, base, query }) => search(root, base, query),
    diff: ({ root, repo, path: rel, staged, untracked }) => diff(inside(root, repo), rel, staged, untracked),
    watch: ({ root }, context) => watch(root, context),
    log: ({ root, repo, all, skip, limit }) => log(inside(root, repo), all, skip, limit),
    show: ({ root, repo, sha }) => show(inside(root, repo), sha),
    branches: ({ root, repo }) => branches(inside(root, repo)),
    commitContext: ({ root, repo }) => commitContext(inside(root, repo)),
    createPr: ({ root, repo, base }) => createPr(inside(root, repo), base),
    applyHunk: ({ root, repo, patch, mode }) => {
      invalidate(root);
      return applyHunk(inside(root, repo), patch, mode);
    },
    claudeCli: ({ root, prompt }) => runClaudeCli(path.resolve(root), prompt),
    compare: ({ root, repo, base }) => compare(inside(root, repo), base),
    compareDiff: ({ root, repo, base, path: rel }) => compareDiff(inside(root, repo), base, rel),
    stage: async ({ root, repo, paths }) => {
      const r = inside(root, repo);
      invalidate(root);
      return { output: await gitOk(r, ["add", "-A", "--", ...relPaths(r, paths)]) };
    },
    unstage: async ({ root, repo, paths }) => {
      const r = inside(root, repo);
      invalidate(root);
      const hasHead = (await git(r, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
      const rels = relPaths(r, paths);
      const output = hasHead
        ? await gitOk(r, ["restore", "--staged", "--", ...rels])
        : await gitOk(r, ["rm", "--cached", "-r", "-q", "--", ...rels]);
      return { output };
    },
    discard: async ({ root, repo, tracked, untracked }) => {
      const r = inside(root, repo);
      invalidate(root);
      const outputs: string[] = [];
      if (tracked.length > 0) {
        outputs.push(
          await gitOk(r, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...relPaths(r, tracked)]),
        );
      }
      if (untracked.length > 0) {
        await git(r, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...relPaths(r, untracked)]);
      }
      for (const rel of untracked) {
        await fs.rm(inside(r, rel), { recursive: true, force: true });
      }
      return { output: outputs.join("\n") };
    },
    commit: async ({ root, repo, message, stageAll, amend }) => {
      const r = inside(root, repo);
      invalidate(root);
      if (stageAll) await gitOk(r, ["add", "-A"]);
      const args = amend ? ["commit", "--amend", "-F", "-"] : ["commit", "-F", "-"];
      return { output: await gitOk(r, args, message) };
    },
    push: async ({ root, repo }) => {
      const r = inside(root, repo);
      const upstream = await git(r, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      const args = upstream.code === 0 ? ["push"] : ["push", "-u", "origin", "HEAD"];
      return { output: await gitOk(r, args) };
    },
    pull: async ({ root, repo }) => {
      const r = inside(root, repo);
      invalidate(root);
      return { output: await gitOk(r, ["pull", "--ff-only"]) };
    },
    createEntry: ({ root, parent, name, dir }) => {
      invalidate(root);
      return createEntry(root, parent, name, dir);
    },
    renameEntry: ({ root, path: rel, name }) => {
      invalidate(root);
      return renameEntry(root, rel, name);
    },
    readText: ({ root, path: rel }) => readText(root, rel),
    writeText: ({ root, path: rel, content, expectedHash }) => {
      invalidate(root);
      return writeText(root, rel, content, expectedHash);
    },
    moveEntry: ({ root, path: rel, toDir }) => {
      invalidate(root);
      return moveEntry(root, rel, toDir);
    },
    duplicateEntry: ({ root, path: rel }) => {
      invalidate(root);
      return duplicateEntry(root, rel);
    },
    deleteEntry: ({ root, path: rel, permanent }) => {
      invalidate(root);
      return deleteEntry(root, rel, permanent);
    },
    readEntry: ({ root, path: rel }) => readEntry(root, rel),
    revealEntry: ({ root, path: rel }) => revealEntry(root, rel),
  },
});
