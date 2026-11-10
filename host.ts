import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  MAX_DIR_ENTRIES,
  MAX_REPOS,
  MAX_SEARCH_RESULTS,
  MAX_STATUS_FILES,
  hostContract,
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
  if (entries.length > 0 && (await isRepo(root))) {
    const prefix = rel === "" ? "" : `${rel.replace(/\/+$/u, "")}/`;
    const input = entries.map((e) => `${prefix}${e.name}${e.dir ? "/" : ""}`).join("\0");
    const result = await git(root, ["check-ignore", "-z", "--stdin"], `${input}\0`).catch(() => null);
    if (result !== null && result.code !== 128) {
      const ignored = new Set(
        result.stdout
          .split("\0")
          .filter(Boolean)
          .map((p) => p.replace(/\/$/u, "")),
      );
      for (const entry of entries) {
        if (ignored.has(`${prefix}${entry.name}`)) entry.ignored = true;
      }
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
  const paths = gitOk(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).then(
    (out) => [...new Set(out.split("\0").filter(Boolean))],
  );
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

async function search(root: string, query: string) {
  if (!(await isRepo(root))) return { paths: [] };
  const needle = query.trim().toLowerCase();
  const scored: Array<{ p: string; s: number }> = [];
  for (const p of await allFiles(root)) {
    const s = fuzzyScore(p, needle);
    if (s !== null) scored.push({ p, s });
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

function invalidate(root: string) {
  lsFilesCache.delete(root);
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

export default experimental_defineHostEntry({
  contract: hostContract,
  dispose: () => {
    repoCache.clear();
    lsFilesCache.clear();
    discoveryCache.clear();
  },
  handlers: {
    listDir: ({ root, rel }) => listDir(root, rel),
    workspaceStatus: ({ root, rescan }) => workspaceStatus(root, rescan),
    search: ({ root, query }) => search(root, query),
    diff: ({ root, repo, path: rel, staged, untracked }) => diff(inside(root, repo), rel, staged, untracked),
    log: ({ root, repo, all, skip, limit }) => log(inside(root, repo), all, skip, limit),
    show: ({ root, repo, sha }) => show(inside(root, repo), sha),
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
  },
});
