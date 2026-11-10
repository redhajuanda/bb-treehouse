import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Change, CompareFile, CompareResult, RepoStatus, WorkspaceStatus } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ROW_HEIGHT, VirtualList } from "./VirtualList";
import { FolderPicker, type FolderOption } from "./FolderPicker";
import { FileIcon } from "./FileIcon";
import {
  DIFF_TAB_REFERENCE,
  compareTabTitle,
  diffTabTitle,
  type CompareDiffParams,
  type FileDiffParams,
} from "./DiffTab";
import { BranchPicker } from "./BranchPicker";
import { badgeClass, badgeOf, errorMessage, useCachedState, type Rpc, fileTarget } from "./data";

type Section = "staged" | "changes";
type Repo = Extract<RepoStatus["status"], { repo: true }>;

const ALL = "\u0000all";
const REPO_HEADER_HEIGHT = 34;
const REPO_HEADER_GAP = 12;
const COMMIT_HEIGHT = 80;
const COMMIT_NOTICE_HEIGHT = 38;
const REPO_HUES = [250, 150, 30, 300, 195, 75, 340, 110];
const GUIDE_LEFT = 17;

function repoHue(repo: string): number {
  let hash = 0;
  for (let i = 0; i < repo.length; i += 1) hash = (hash * 31 + repo.charCodeAt(i)) | 0;
  return REPO_HUES[Math.abs(hash) % REPO_HUES.length] ?? 250;
}

function repoColor(repo: string, alpha = 1): string {
  return `oklch(0.72 0.14 ${repoHue(repo)} / ${alpha})`;
}

function RepoGuide({ repo }: { repo: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-0.5 rounded-full"
      style={{ left: GUIDE_LEFT, background: repoColor(repo, 0.45) }}
    />
  );
}

type Item =
  | { kind: "repo"; repo: string; label: string; status: Repo; expanded: boolean; first: boolean }
  | { kind: "commit"; repo: string; status: Repo; notice: boolean }
  | { kind: "section"; repo: string; section: Section; count: number; collapsed: boolean }
  | { kind: "file"; repo: string; section: Section; change: Change }
  | { kind: "clean"; repo: string }
  | { kind: "compare"; repo: string; base: string | null; open: boolean; state: CompareState | undefined }
  | { kind: "compare-file"; repo: string; base: string; file: CompareFile }
  | { kind: "compare-note"; repo: string; text: string; tone: "muted" | "error" };

type CompareState =
  | { status: "loading"; base: string }
  | { status: "ready"; base: string; result: CompareResult }
  | { status: "error"; base: string; message: string };

const compareOpenByEnv = new Map<string, Map<string, boolean>>();
const compareBaseByEnv = new Map<string, Map<string, string>>();
const compareDataCache = new Map<string, Map<string, CompareState>>();

interface Selected {
  repo: string;
  path: string;
  staged: boolean;
  untracked: boolean;
}

interface Notice {
  tone: "error" | "info";
  text: string;
}

const drafts = new Map<string, string>();
const groupChoice = new Map<string, string>();
const expandedRepos = new Map<string, Map<string, boolean>>();
const collapsedSections = new Map<string, Set<string>>();

function isStaged(change: Change): boolean {
  return change.x !== " " && change.x !== "?";
}

function isUnstaged(change: Change): boolean {
  return change.y !== " " || change.x === "?";
}

function parentOf(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash === -1 ? "" : repo.slice(0, slash);
}

function splitName(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? { name: trimmed, dir: "" } : { name: trimmed.slice(slash + 1), dir: trimmed.slice(0, slash) };
}

function joinPath(repo: string, path: string): string {
  return repo === "" ? path : `${repo}/${path}`;
}

function heightOf(item: Item): number {
  if (item.kind === "repo") return item.first ? REPO_HEADER_HEIGHT : REPO_HEADER_HEIGHT + REPO_HEADER_GAP;
  if (item.kind === "commit") return item.notice ? COMMIT_HEIGHT + COMMIT_NOTICE_HEIGHT : COMMIT_HEIGHT;
  return ROW_HEIGHT;
}

function keyOf(item: Item): string {
  switch (item.kind) {
    case "repo":
      return `r:${item.repo}`;
    case "clean":
      return `n:${item.repo}`;
    case "commit":
      return `c:${item.repo}`;
    case "section":
      return `s:${item.repo}:${item.section}`;
    case "file":
      return `f:${item.repo}:${item.section}:${item.change.path}`;
    case "compare":
      return `x:${item.repo}`;
    case "compare-file":
      return `xf:${item.repo}:${item.file.path}`;
    case "compare-note":
      return `xn:${item.repo}`;
  }
}

export function GitView({
  rpc,
  environmentId,
  workspace,
  workspaceError,
  reload,
  signal,
}: {
  rpc: Rpc;
  environmentId: string;
  workspace: WorkspaceStatus | null;
  workspaceError: string | null;
  reload: () => void;
  signal: number;
}) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<Map<string, string>>(() => new Map());
  const [notices, setNotices] = useState<Map<string, Notice>>(() => new Map());
  const panel = experimental_useAppPanel();
  const [expanded, setExpanded] = useState<Map<string, boolean>>(() => expandedRepos.get(environmentId) ?? new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedSections.get(environmentId) ?? new Set());
  const [choice, setChoiceState] = useState<string | null>(() => groupChoice.get(environmentId) ?? null);

  const repos = useMemo(
    () => (workspace?.repos ?? []).flatMap((r) => (r.status.repo ? [{ repo: r.repo, status: r.status }] : [])),
    [workspace],
  );

  const groups = useMemo(() => {
    const byParent = new Map<string, string[]>();
    for (const { repo } of repos) {
      const key = repo === "" ? "" : parentOf(repo);
      const list = byParent.get(key) ?? [];
      list.push(repo);
      byParent.set(key, list);
    }
    return [...byParent.entries()]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, undefined, { numeric: true })))
      .map(([key, members]) => ({
        key,
        label: key === "" ? (workspace?.name ?? "workspace") : key,
        members,
        changes: members.reduce((sum, m) => {
          const found = repos.find((r) => r.repo === m);
          return sum + (found?.status.files.length ?? 0);
        }, 0),
      }));
  }, [repos, workspace?.name]);

  const group =
    choice === ALL ? ALL : choice !== null && groups.some((g) => g.key === choice) ? choice : (groups[0]?.key ?? ALL);

  const folderOptions = useMemo<FolderOption[]>(() => {
    const total = groups.reduce((sum, g) => sum + g.changes, 0);
    return [
      {
        key: ALL,
        title: "All repositories",
        path: "",
        repos: repos.map((r) => (r.repo === "" ? (workspace?.name ?? "workspace") : r.repo)),
        changes: total,
        all: true,
      },
      ...groups.map((g) => ({
        key: g.key,
        title: g.key === "" ? g.label : g.key.slice(g.key.lastIndexOf("/") + 1),
        path: g.key === "" ? "workspace root" : g.key,
        repos: g.members.map((m) => (m === "" ? (workspace?.name ?? "workspace") : m.slice(m.lastIndexOf("/") + 1))),
        changes: g.changes,
        all: false,
      })),
    ];
  }, [groups, repos, workspace?.name]);

  const setChoice = (value: string) => {
    groupChoice.set(environmentId, value);
    setChoiceState(value);
  };

  const visibleRepos = useMemo(() => {
    if (group === ALL) return repos;
    const members = new Set(groups.find((g) => g.key === group)?.members ?? []);
    return repos.filter((r) => members.has(r.repo));
  }, [repos, groups, group]);

  const labelFor = useCallback(
    (repo: string) => {
      if (repo === "") return workspace?.name ?? "workspace";
      if (group === ALL || group === "") return repo;
      return repo.slice(group.length + 1);
    },
    [group, workspace?.name],
  );

  const isExpanded = useCallback(
    (repo: string, status: Repo) => expanded.get(repo) ?? (visibleRepos.length === 1 || status.files.length > 0),
    [expanded, visibleRepos.length],
  );

  const [compareOpen, setCompareOpen] = useState<Map<string, boolean>>(
    () => compareOpenByEnv.get(environmentId) ?? new Map(),
  );
  const [compareBase, setCompareBase] = useState<Map<string, string>>(
    () => compareBaseByEnv.get(environmentId) ?? new Map(),
  );
  const [compareData, setCompareData] = useCachedState(
    compareDataCache,
    environmentId,
    () => new Map<string, CompareState>(),
  );

  const isCompareOpen = useCallback((repo: string) => compareOpen.get(repo) ?? false, [compareOpen]);
  const baseFor = useCallback((repo: string) => compareBase.get(repo) ?? null, [compareBase]);

  const compareTargets = useMemo(
    () =>
      visibleRepos
        .filter(({ repo, status }) => isExpanded(repo, status) && isCompareOpen(repo))
        .map(({ repo, status }) => ({ repo, head: `${status.branch ?? ""}:${status.ahead}:${status.behind}` })),
    [visibleRepos, isExpanded, isCompareOpen],
  );
  const compareKey = compareTargets.map((t) => `${t.repo}\u0000${baseFor(t.repo) ?? ""}\u0000${t.head}`).join("\n");

  useEffect(() => {
    let cancelled = false;
    for (const { repo } of compareTargets) {
      const base = baseFor(repo);
      if (base === null) continue;
      setCompareData((prev) => {
        const current = prev.get(repo);
        if (current !== undefined && current.base === base && current.status !== "error") return prev;
        return new Map(prev).set(repo, { status: "loading", base });
      });
      rpc.call("compare", { environmentId, repo, base }).then(
        (result) => {
          if (cancelled) return;
          setCompareData((prev) => {
            const current = prev.get(repo);
            if (
              current?.status === "ready" &&
              current.base === base &&
              JSON.stringify(current.result) === JSON.stringify(result)
            ) {
              return prev;
            }
            return new Map(prev).set(repo, { status: "ready", base, result });
          });
        },
        (cause: unknown) => {
          if (!cancelled)
            setCompareData((prev) => new Map(prev).set(repo, { status: "error", base, message: errorMessage(cause) }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [compareKey, signal, rpc, environmentId]);

  const toggleCompare = useCallback(
    (repo: string, current: boolean) => {
      setCompareOpen((prev) => {
        const next = new Map(prev).set(repo, !current);
        compareOpenByEnv.set(environmentId, next);
        return next;
      });
    },
    [environmentId],
  );
  const chooseBase = useCallback(
    (repo: string, base: string) => {
      setCompareBase((prev) => {
        const next = new Map(prev).set(repo, base);
        compareBaseByEnv.set(environmentId, next);
        return next;
      });
      setCompareOpen((prev) => {
        const next = new Map(prev).set(repo, true);
        compareOpenByEnv.set(environmentId, next);
        return next;
      });
    },
    [environmentId],
  );

  const items = useMemo(() => {
    const out: Item[] = [];
    for (const { repo, status } of visibleRepos) {
      const open = isExpanded(repo, status);
      out.push({
        kind: "repo",
        repo,
        label: labelFor(repo),
        status,
        expanded: open,
        first: out.length === 0,
      });
      if (!open) continue;
      out.push({ kind: "commit", repo, status, notice: notices.has(repo) || status.truncated });
      if (status.files.length === 0) {
        out.push({ kind: "clean", repo });
      }
      const lists: Array<[Section, Change[]]> = [
        ["staged", status.files.filter(isStaged)],
        ["changes", status.files.filter(isUnstaged)],
      ];
      for (const [section, list] of lists) {
        if (list.length === 0) continue;
        const isCollapsed = collapsed.has(`${repo}\u0000${section}`);
        out.push({ kind: "section", repo, section, count: list.length, collapsed: isCollapsed });
        if (isCollapsed) continue;
        for (const change of list) out.push({ kind: "file", repo, section, change });
      }
      const base = baseFor(repo);
      const compareIsOpen = base !== null && isCompareOpen(repo);
      const state = compareData.get(repo);
      out.push({ kind: "compare", repo, base, open: compareIsOpen, state: state?.base === base ? state : undefined });
      if (!compareIsOpen) continue;
      if (base === null) continue;
      if (state === undefined || state.base !== base || state.status === "loading") {
        out.push({ kind: "compare-note", repo, text: "Comparing…", tone: "muted" });
        continue;
      }
      if (state.status === "error") {
        out.push({ kind: "compare-note", repo, text: state.message, tone: "error" });
        continue;
      }
      if (!state.result.found) {
        out.push({ kind: "compare-note", repo, text: `No common history with ${base}.`, tone: "muted" });
        continue;
      }
      if (state.result.files.length === 0) {
        out.push({ kind: "compare-note", repo, text: `No differences from ${base}.`, tone: "muted" });
        continue;
      }
      for (const file of state.result.files) out.push({ kind: "compare-file", repo, base, file });
    }
    return out;
  }, [visibleRepos, isExpanded, labelFor, collapsed, notices, isCompareOpen, baseFor, compareData]);

  const toggleRepo = useCallback(
    (repo: string, current: boolean) => {
      setExpanded((prev) => {
        const next = new Map(prev);
        next.set(repo, !current);
        expandedRepos.set(environmentId, next);
        return next;
      });
    },
    [environmentId],
  );

  const toggleSection = useCallback(
    (repo: string, section: Section) => {
      setCollapsed((prev) => {
        const key = `${repo}\u0000${section}`;
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        collapsedSections.set(environmentId, next);
        return next;
      });
    },
    [environmentId],
  );

  const run = useCallback(
    async (repo: string, label: string, action: () => Promise<{ output: string }>, success?: string) => {
      setBusy((prev) => new Map(prev).set(repo, label));
      setNotices((prev) => {
        const next = new Map(prev);
        next.delete(repo);
        return next;
      });
      try {
        const result = await action();
        const text =
          success ??
          (label === "push" || label === "pull" || label === "pr"
            ? result.output.split("\n").slice(-2).join(" ") || "Done."
            : null);
        if (text !== null) setNotices((prev) => new Map(prev).set(repo, { tone: "info", text }));
        return true;
      } catch (cause) {
        setNotices((prev) => new Map(prev).set(repo, { tone: "error", text: errorMessage(cause) }));
        return false;
      } finally {
        setBusy((prev) => {
          const next = new Map(prev);
          next.delete(repo);
          return next;
        });
        reload();
      }
    },
    [reload],
  );

  const actions = useMemo(
    () => ({
      stage: (repo: string, paths: string[]) =>
        void run(repo, "stage", () => rpc.call("stage", { environmentId, repo, paths })),
      unstage: (repo: string, paths: string[]) =>
        void run(repo, "unstage", () => rpc.call("unstage", { environmentId, repo, paths })),
      discard: (repo: string, changes: Change[]) => {
        const tracked: string[] = [];
        const untracked: string[] = [];
        for (const c of changes) {
          if (c.x === "?" || c.x === "A") untracked.push(c.path);
          else tracked.push(c.path);
        }
        void run(repo, "discard", () => rpc.call("discard", { environmentId, repo, tracked, untracked }));
      },
      push: (repo: string) => void run(repo, "push", () => rpc.call("push", { environmentId, repo })),
      pull: (repo: string) => void run(repo, "pull", () => rpc.call("pull", { environmentId, repo })),
      commit: (repo: string, message: string, stagedCount: number, mode: CommitMode) => {
        const stageAll = stagedCount === 0 && mode !== "amend";
        const amend = mode === "amend";
        return run(
          repo,
          "commit",
          async () => {
            const committed = await rpc.call("commit", { environmentId, repo, message, stageAll, amend });
            if (mode !== "push") return committed;
            const pushed = await rpc.call("push", { environmentId, repo });
            return { output: `${committed.output}\n${pushed.output}` };
          },
          amend
            ? "Amended the last commit."
            : mode === "push"
              ? "Committed and pushed."
              : stageAll
                ? "Committed all changes."
                : `Committed ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}.`,
        );
      },
      open: (repo: string, path: string) => {
        const target = fileTarget(environmentId, joinPath(repo, path));
        if (target !== null) void navigate.experimental_openFilePreview({ target, location: null });
      },
      select: (value: Selected) => {
        const params: FileDiffParams = { kind: "file", ...value };
        if (panel.openTab({ tab: DIFF_TAB_REFERENCE, params, title: diffTabTitle(params) })) return;
        const target = fileTarget(environmentId, joinPath(value.repo, value.path));
        if (target !== null) void navigate.experimental_openFilePreview({ target, location: null });
      },
      suggest: async (repo: string): Promise<string | null> => {
        setNotices((prev) => {
          const next = new Map(prev);
          next.delete(repo);
          return next;
        });
        try {
          return (await rpc.call("suggestMessage", { environmentId, repo })).message;
        } catch (cause) {
          setNotices((prev) => new Map(prev).set(repo, { tone: "error", text: errorMessage(cause) }));
          return null;
        }
      },
      createPr: (repo: string, base: string) =>
        void run(
          repo,
          "pr",
          async () => {
            const result = await rpc.call("createPr", { environmentId, repo, base });
            if (result.url === null) {
              throw new Error(
                "Pushed, but this remote isn't GitHub, GitLab or Bitbucket, so there's no pull request page to open.",
              );
            }
            navigate.openUrl(result.url);
            return {
              output: result.pushed ? "Pushed and opened the pull request page." : "Opened the pull request page.",
            };
          },
          undefined,
        ),
      openCompare: (repo: string, base: string, path: string) => {
        const params: CompareDiffParams = { kind: "compare", repo, base, path };
        if (panel.openTab({ tab: DIFF_TAB_REFERENCE, params, title: compareTabTitle(params) })) return;
        setNotices((prev) =>
          new Map(prev).set(repo, { tone: "info", text: "Branch diffs open in a tab once the thread has started." }),
        );
      },
    }),
    [run, rpc, environmentId, navigate, panel],
  );

  if (workspace === null) {
    return (
      <p className={cn("px-4 py-3 text-sm", workspaceError === null ? "text-muted-foreground" : "text-destructive")}>
        {workspaceError ?? "Loading…"}
      </p>
    );
  }
  if (repos.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No git repositories in this workspace.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {groups.length > 1 || repos.length > 1 ? (
        <FolderPicker options={folderOptions} value={group} onChange={setChoice} />
      ) : null}
      {workspace.truncated ? (
        <p className="px-3 pb-1 text-xs text-muted-foreground">Repository scan stopped early; some may be missing.</p>
      ) : null}
      <VirtualList
        items={items}
        getKey={keyOf}
        getHeight={heightOf}
        className="pb-2"
        scrollKey={`diff:${environmentId}:${group}`}
        renderRow={(item) => {
          const repoBusy = busy.get(item.repo) ?? null;
          switch (item.kind) {
            case "repo":
              return (
                <RepoHeader
                  repo={item.repo}
                  label={item.label}
                  status={item.status}
                  expanded={item.expanded}
                  first={item.first}
                  multi={visibleRepos.length > 1}
                  busy={repoBusy}
                  onToggle={toggleRepo}
                  onPush={actions.push}
                  onPull={actions.pull}
                />
              );
            case "commit":
              return (
                <CommitBox
                  key={`${environmentId}\u0000${item.repo}`}
                  draftKey={`${environmentId}\u0000${item.repo}`}
                  repo={item.repo}
                  status={item.status}
                  busy={repoBusy}
                  notice={notices.get(item.repo) ?? null}
                  onCommit={actions.commit}
                  onSuggest={actions.suggest}
                />
              );
            case "clean":
              return (
                <p className="relative flex h-full items-center pl-11 text-xs text-muted-foreground">
                  <RepoGuide repo={item.repo} />
                  No uncommitted changes
                </p>
              );
            case "compare":
              return (
                <CompareHeader
                  rpc={rpc}
                  environmentId={environmentId}
                  repo={item.repo}
                  base={item.base}
                  open={item.open}
                  state={item.state}
                  onToggle={toggleCompare}
                  onBase={chooseBase}
                  busy={repoBusy}
                  onCreatePr={actions.createPr}
                />
              );
            case "compare-note":
              return (
                <p
                  className={cn(
                    "relative flex h-full items-center pl-11 text-xs",
                    item.tone === "error" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  <RepoGuide repo={item.repo} />
                  <span className="truncate">{item.text}</span>
                </p>
              );
            case "compare-file":
              return <CompareFileRow repo={item.repo} base={item.base} file={item.file} onOpen={actions.openCompare} />;
            case "section":
              return (
                <SectionHeader
                  repo={item.repo}
                  section={item.section}
                  count={item.count}
                  collapsed={item.collapsed}
                  disabled={repoBusy !== null}
                  status={visibleRepos.find((r) => r.repo === item.repo)?.status ?? null}
                  onToggle={toggleSection}
                  onStage={actions.stage}
                  onUnstage={actions.unstage}
                  onDiscard={actions.discard}
                />
              );
            case "file":
              return (
                <FileRow
                  repo={item.repo}
                  change={item.change}
                  section={item.section}
                  disabled={repoBusy !== null}
                  onSelect={actions.select}
                  onOpen={actions.open}
                  onStage={actions.stage}
                  onUnstage={actions.unstage}
                  onDiscard={actions.discard}
                />
              );
          }
        }}
      />
    </div>
  );
}

const RepoHeader = memo(function RepoHeader({
  repo,
  label,
  status,
  expanded,
  first,
  multi,
  busy,
  onToggle,
  onPush,
  onPull,
}: {
  repo: string;
  label: string;
  status: Repo;
  expanded: boolean;
  first: boolean;
  multi: boolean;
  busy: string | null;
  onToggle: (repo: string, current: boolean) => void;
  onPush: (repo: string) => void;
  onPull: (repo: string) => void;
}) {
  const publish = status.upstream === null;
  const color = repoColor(repo);
  return (
    <div className="flex h-full flex-col justify-end">
      {first ? null : <div aria-hidden className="mx-3 mb-auto mt-1.5 h-px bg-border" />}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={`${repo === "" ? "." : repo}${publish ? " · no upstream" : ` → ${status.upstream}`}`}
        onClick={() => onToggle(repo, expanded)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(repo, expanded);
          }
        }}
        className="relative mx-1 flex h-[30px] shrink-0 items-center gap-1.5 rounded-md pl-0.5 pr-1.5 text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        </span>
        {multi ? (
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-xs font-bold uppercase"
            style={{ background: repoColor(repo, 0.18), color }}
          >
            {label.replace(/^\./u, "").slice(0, 1) || "·"}
          </span>
        ) : null}
        <span className="min-w-0 shrink truncate font-semibold">{label}</span>
        <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {status.branch ?? "detached"}
        </span>
        {status.behind > 0 ? (
          <SyncButton
            icon="ArrowDown"
            count={status.behind}
            title={`Pull ${status.behind} commit${status.behind === 1 ? "" : "s"} (fast-forward only)`}
            spinning={busy === "pull"}
            disabled={busy !== null}
            onClick={() => onPull(repo)}
          />
        ) : null}
        {status.ahead > 0 || publish ? (
          <SyncButton
            icon="ArrowUp"
            count={publish ? null : status.ahead}
            title={
              publish
                ? "Publish branch (push and set upstream)"
                : `Push ${status.ahead} commit${status.ahead === 1 ? "" : "s"}`
            }
            spinning={busy === "push"}
            disabled={busy !== null}
            onClick={() => onPush(repo)}
          />
        ) : null}
      </div>
    </div>
  );
});

function SyncButton({
  icon,
  count,
  title,
  spinning,
  disabled,
  onClick,
}: {
  icon: string;
  count: number | null;
  title: string;
  spinning: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-6 shrink-0 items-center gap-0.5 rounded px-1.5 font-mono text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
    >
      <Icon name={spinning ? "Spinner" : icon} className={cn("size-3.5", spinning && "animate-spin")} />
      {count === null ? <span className="font-sans">Publish</span> : count}
    </button>
  );
}

type CommitMode = "commit" | "push" | "amend";

const COMMIT_MODES: ReadonlyArray<{ mode: CommitMode; label: string; icon: string }> = [
  { mode: "commit", label: "Commit", icon: "Check" },
  { mode: "push", label: "Commit & Push", icon: "ArrowUp" },
  { mode: "amend", label: "Amend Last Commit", icon: "Edit" },
];

function CommitBox({
  draftKey,
  repo,
  status,
  busy,
  notice,
  onCommit,
  onSuggest,
}: {
  draftKey: string;
  repo: string;
  status: Repo;
  busy: string | null;
  notice: Notice | null;
  onCommit: (repo: string, message: string, stagedCount: number, mode: CommitMode) => Promise<boolean>;
  onSuggest: (repo: string) => Promise<string | null>;
}) {
  const [message, setMessageState] = useState(() => drafts.get(draftKey) ?? "");
  const [suggesting, setSuggesting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const setMessage = (value: string) => {
    drafts.set(draftKey, value);
    setMessageState(value);
  };
  const stagedCount = status.files.filter(isStaged).length;
  const total = status.files.length;
  const mac = navigator.platform.startsWith("Mac");
  const branch = status.branch ?? "HEAD";

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const canRun = (mode: CommitMode) => busy === null && message.trim() !== "" && (mode === "amend" ? true : total > 0);
  const commit = async (mode: CommitMode) => {
    setMenuOpen(false);
    const text = message.trim();
    if (!canRun(mode)) return;
    if (await onCommit(repo, text, stagedCount, mode)) setMessage("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void commit("commit");
    }
  };
  const title =
    total === 0
      ? "Nothing to commit"
      : stagedCount > 0
        ? `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`
        : `Stage all ${total} change${total === 1 ? "" : "s"} and commit`;

  return (
    <div className="relative flex h-full flex-col gap-1.5 py-1.5 pl-9 pr-2">
      <RepoGuide repo={repo} />
      <div className="relative shrink-0">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={suggesting}
          placeholder={
            suggesting ? "Writing a message…" : `Message (${mac ? "⌘↵" : "Ctrl+↵"} to commit on "${branch}")`
          }
          className="block h-8 w-full resize-none overflow-hidden rounded-md border border-input bg-transparent py-1.5 pl-2.5 pr-9 text-sm leading-[18px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-70"
        />
        <button
          type="button"
          title="Write a commit message with Claude"
          disabled={suggesting || busy !== null || total === 0}
          onClick={async () => {
            setSuggesting(true);
            const suggestion = await onSuggest(repo);
            setSuggesting(false);
            if (suggestion !== null) setMessage(suggestion);
          }}
          className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
        >
          <Icon
            name={suggesting ? "Spinner" : "AiContentGenerator01"}
            className={cn("size-4", suggesting && "animate-spin")}
          />
        </button>
      </div>
      <div ref={menuRef} className="relative flex h-[30px] shrink-0">
        <button
          type="button"
          title={title}
          disabled={!canRun("commit")}
          onClick={() => void commit("commit")}
          className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-[oklch(0.56_0.17_255)] text-sm font-medium text-white hover:bg-[oklch(0.51_0.17_255)] disabled:opacity-50"
        >
          <Icon
            name={busy === "commit" ? "Spinner" : "Check"}
            className={cn("size-4", busy === "commit" && "animate-spin")}
          />
          Commit
        </button>
        <span aria-hidden className="w-px bg-[oklch(0.56_0.17_255)]">
          <span className="block h-full w-full bg-white/30" />
        </span>
        <button
          type="button"
          title="More commit actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!COMMIT_MODES.some((entry) => canRun(entry.mode))}
          onClick={() => setMenuOpen((open) => !open)}
          className="flex w-8 shrink-0 items-center justify-center rounded-r-md bg-[oklch(0.56_0.17_255)] text-white hover:bg-[oklch(0.51_0.17_255)] disabled:opacity-50"
        >
          <Icon name="ChevronDown" className="size-4" />
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {COMMIT_MODES.map((entry) => (
              <button
                key={entry.mode}
                type="button"
                role="menuitem"
                disabled={!canRun(entry.mode)}
                onClick={() => void commit(entry.mode)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover disabled:opacity-50"
              >
                <Icon name={entry.icon} className="size-4 text-muted-foreground" />
                {entry.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {notice !== null || status.truncated ? (
        <p
          role={notice?.tone === "error" ? "alert" : "status"}
          title={notice?.text}
          className={cn(
            "line-clamp-2 shrink-0 break-words text-xs leading-4",
            notice?.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {notice?.text ?? `Showing the first ${total} changes.`}
        </p>
      ) : null}
    </div>
  );
}

function ConfirmButton({
  icon,
  title,
  disabled,
  onConfirm,
}: {
  icon: string;
  title: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      title={armed ? `${title}: click again to confirm` : title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded disabled:opacity-50",
        armed
          ? "bg-destructive text-destructive-foreground hover:bg-destructive"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      <Icon name={armed ? "Check" : icon} className="size-3.5" />
    </button>
  );
}

function IconAction({
  icon,
  title,
  disabled,
  onClick,
}: {
  icon: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

const SectionHeader = memo(function SectionHeader({
  repo,
  section,
  count,
  collapsed,
  disabled,
  status,
  onToggle,
  onStage,
  onUnstage,
  onDiscard,
}: {
  repo: string;
  section: Section;
  count: number;
  collapsed: boolean;
  disabled: boolean;
  status: Repo | null;
  onToggle: (repo: string, section: Section) => void;
  onStage: (repo: string, paths: string[]) => void;
  onUnstage: (repo: string, paths: string[]) => void;
  onDiscard: (repo: string, changes: Change[]) => void;
}) {
  const files = status?.files ?? [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggle(repo, section)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle(repo, section);
        }
      }}
      className="relative flex h-full cursor-pointer items-center pr-1"
    >
      <RepoGuide repo={repo} />
      <span className="ml-6 flex h-full flex-1 items-center gap-1 rounded-md px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-state-hover hover:text-foreground">
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
        <span>{section === "staged" ? "Staged" : "Changes"}</span>
        <span className="font-normal">{count}</span>
        <span className="flex-1" />
        {section === "staged" ? (
          <IconAction
            icon="Minus"
            title="Unstage all"
            disabled={disabled}
            onClick={() =>
              onUnstage(
                repo,
                files.filter(isStaged).map((c) => c.path),
              )
            }
          />
        ) : (
          <>
            <ConfirmButton
              icon="RotateCcw"
              title="Discard all changes"
              disabled={disabled}
              onConfirm={() => onDiscard(repo, files.filter(isUnstaged))}
            />
            <IconAction
              icon="Plus"
              title="Stage all"
              disabled={disabled}
              onClick={() =>
                onStage(
                  repo,
                  files.filter(isUnstaged).map((c) => c.path),
                )
              }
            />
          </>
        )}
      </span>
    </div>
  );
});

const FileRow = memo(function FileRow({
  repo,
  change,
  section,
  disabled,
  onSelect,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
}: {
  repo: string;
  change: Change;
  section: Section;
  disabled: boolean;
  onSelect: (selected: Selected) => void;
  onOpen: (repo: string, path: string) => void;
  onStage: (repo: string, paths: string[]) => void;
  onUnstage: (repo: string, paths: string[]) => void;
  onDiscard: (repo: string, changes: Change[]) => void;
}) {
  const badge = badgeOf(change);
  const tone = badgeClass(badge);
  const { name, dir } = splitName(change.path);
  const deleted = badge === "D";
  const select = () => onSelect({ repo, path: change.path, staged: section === "staged", untracked: change.x === "?" });
  return (
    <div
      role="button"
      tabIndex={0}
      title={change.orig === null ? change.path : `${change.orig} → ${change.path}`}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter") select();
      }}
      className="group relative flex h-full cursor-pointer items-center gap-1.5 pl-11 pr-2 text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      <RepoGuide repo={repo} />
      <FileIcon name={name} className={cn(deleted && "opacity-50")} />
      <span className={cn("shrink-0", deleted && "line-through")}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
        {deleted ? null : (
          <IconAction icon="FileText" title="Open file" disabled={false} onClick={() => onOpen(repo, change.path)} />
        )}
        {section === "staged" ? (
          <IconAction icon="Minus" title="Unstage" disabled={disabled} onClick={() => onUnstage(repo, [change.path])} />
        ) : (
          <>
            <ConfirmButton
              icon="RotateCcw"
              title="Discard changes"
              disabled={disabled}
              onConfirm={() => onDiscard(repo, [change])}
            />
            <IconAction icon="Plus" title="Stage" disabled={disabled} onClick={() => onStage(repo, [change.path])} />
          </>
        )}
      </span>
      <span className="shrink-0 font-mono text-xs group-hover:hidden group-focus-within:hidden">
        {change.add === null ? null : <span className="text-diff-added">+{change.add}</span>}
        {change.del === null || change.del === 0 ? null : <span className="text-diff-removed"> -{change.del}</span>}
      </span>
      <span className={cn("w-3 shrink-0 text-center text-xs font-semibold", tone)}>{badge}</span>
    </div>
  );
});

function CompareHeader({
  rpc,
  environmentId,
  repo,
  base,
  open,
  state,
  onToggle,
  onBase,
  busy,
  onCreatePr,
}: {
  rpc: Rpc;
  environmentId: string;
  repo: string;
  base: string | null;
  open: boolean;
  state: CompareState | undefined;
  onToggle: (repo: string, current: boolean) => void;
  onBase: (repo: string, base: string) => void;
  busy: string | null;
  onCreatePr: (repo: string, base: string) => void;
}) {
  const result = state?.status === "ready" ? state.result : null;
  let add = 0;
  let del = 0;
  for (const f of result?.files ?? []) {
    add += f.add ?? 0;
    del += f.del ?? 0;
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => {
        if (base !== null) onToggle(repo, open);
      }}
      onKeyDown={(event) => {
        if (base !== null && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onToggle(repo, open);
        }
      }}
      className="relative flex h-full items-center pr-1"
    >
      <RepoGuide repo={repo} />
      <span className="ml-6 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
        {base === null ? (
          <Icon name="GitBranch" className="size-3.5 shrink-0" />
        ) : (
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0 font-semibold uppercase tracking-wide">Compare</span>
        <span className="shrink-0">with</span>
        <BranchPicker
          rpc={rpc}
          environmentId={environmentId}
          repo={repo}
          value={base}
          onChange={(next) => onBase(repo, next)}
        />
        <span className="min-w-0 flex-1" />
        {result !== null && result.found ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono">
            <span title={`${result.ahead} commit${result.ahead === 1 ? "" : "s"} not in ${result.base}`}>
              ↑{result.ahead}
            </span>
            <span title={`${result.behind} commit${result.behind === 1 ? "" : "s"} in ${result.base} not here`}>
              ↓{result.behind}
            </span>
            <span className="font-sans">
              · {result.files.length} file{result.files.length === 1 ? "" : "s"}
            </span>
            {add > 0 ? <span className="text-diff-added">+{add}</span> : null}
            {del > 0 ? <span className="text-diff-removed">-{del}</span> : null}
          </span>
        ) : state?.status === "loading" ? (
          <Icon name="Spinner" className="size-3.5 shrink-0 animate-spin" />
        ) : null}
        {base !== null && result !== null && result.found && result.ahead > 0 ? (
          <button
            type="button"
            title={`Push this branch and open a pull request into ${base}`}
            disabled={busy !== null}
            onClick={(event) => {
              event.stopPropagation();
              onCreatePr(repo, base);
            }}
            className="ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md bg-[oklch(0.56_0.17_255)] px-2 font-sans text-xs font-medium text-white hover:bg-[oklch(0.51_0.17_255)] disabled:opacity-50"
          >
            <Icon
              name={busy === "pr" ? "Spinner" : "GitPullRequest"}
              className={cn("size-3.5", busy === "pr" && "animate-spin")}
            />
            Create PR
          </button>
        ) : null}
      </span>
    </div>
  );
}

const COMPARE_TONES: Record<CompareFile["status"], string> = {
  A: "text-diff-added",
  C: "text-diff-added",
  D: "text-diff-removed",
  M: "text-warning",
  R: "text-warning",
  T: "text-warning",
};

const CompareFileRow = memo(function CompareFileRow({
  repo,
  base,
  file,
  onOpen,
}: {
  repo: string;
  base: string;
  file: CompareFile;
  onOpen: (repo: string, base: string, path: string) => void;
}) {
  const { name, dir } = splitName(file.path);
  const tone = COMPARE_TONES[file.status];
  return (
    <div
      role="button"
      tabIndex={0}
      title={file.orig === null ? file.path : `${file.orig} → ${file.path}`}
      onClick={() => onOpen(repo, base, file.path)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(repo, base, file.path);
      }}
      className="relative flex h-full items-center gap-1.5 pl-11 pr-2 text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      <RepoGuide repo={repo} />
      <FileIcon name={name} className={cn(file.status === "D" && "opacity-50")} />
      <span className={cn("shrink-0", file.status === "D" && "line-through")}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
      <span className="shrink-0 font-mono text-xs">
        {file.add !== null && file.add > 0 ? <span className="text-diff-added">+{file.add}</span> : null}
        {file.del !== null && file.del > 0 ? <span className="text-diff-removed"> -{file.del}</span> : null}
      </span>
      <span className={cn("w-3 shrink-0 text-center text-xs font-semibold", tone)}>{file.status}</span>
    </div>
  );
});
