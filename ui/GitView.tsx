import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { experimental_Diff as Diff, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Change, RepoStatus, WorkspaceStatus } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ROW_HEIGHT, VirtualList } from "./VirtualList";
import { badgeClass, badgeOf, errorMessage, type Rpc } from "./data";

type Section = "staged" | "changes";
type Repo = Extract<RepoStatus["status"], { repo: true }>;

const ALL = "\u0000all";
const REPO_HEADER_HEIGHT = 34;
const COMMIT_HEIGHT = 136;

type Item =
  | { kind: "repo"; repo: string; label: string; status: Repo; expanded: boolean }
  | { kind: "commit"; repo: string; status: Repo }
  | { kind: "section"; repo: string; section: Section; count: number; collapsed: boolean }
  | { kind: "file"; repo: string; section: Section; change: Change }
  | { kind: "clean"; repo: string };

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
  if (item.kind === "repo") return REPO_HEADER_HEIGHT;
  if (item.kind === "commit") return COMMIT_HEIGHT;
  return ROW_HEIGHT;
}

function keyOf(item: Item): string {
  switch (item.kind) {
    case "repo":
      return `r:${item.repo}`;
    case "commit":
      return `c:${item.repo}`;
    case "clean":
      return `n:${item.repo}`;
    case "section":
      return `s:${item.repo}:${item.section}`;
    case "file":
      return `f:${item.repo}:${item.section}:${item.change.path}`;
  }
}

export function GitView({
  rpc,
  environmentId,
  workspace,
  workspaceError,
  reload,
}: {
  rpc: Rpc;
  environmentId: string;
  workspace: WorkspaceStatus | null;
  workspaceError: string | null;
  reload: () => void;
}) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<Map<string, string>>(() => new Map());
  const [notices, setNotices] = useState<Map<string, Notice>>(() => new Map());
  const [selected, setSelected] = useState<Selected | null>(null);
  const [expanded, setExpanded] = useState<Map<string, boolean>>(
    () => expandedRepos.get(environmentId) ?? new Map(),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedSections.get(environmentId) ?? new Set());
  const [choice, setChoiceState] = useState<string | null>(() => groupChoice.get(environmentId) ?? null);

  const repos = useMemo(
    () =>
      (workspace?.repos ?? []).flatMap((r) => (r.status.repo ? [{ repo: r.repo, status: r.status }] : [])),
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
    choice === ALL
      ? ALL
      : choice !== null && groups.some((g) => g.key === choice)
        ? choice
        : (groups[0]?.key ?? ALL);

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

  const items = useMemo(() => {
    const out: Item[] = [];
    for (const { repo, status } of visibleRepos) {
      const open = isExpanded(repo, status);
      out.push({ kind: "repo", repo, label: labelFor(repo), status, expanded: open });
      if (!open) continue;
      out.push({ kind: "commit", repo, status });
      if (status.files.length === 0) {
        out.push({ kind: "clean", repo });
        continue;
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
    }
    return out;
  }, [visibleRepos, isExpanded, labelFor, collapsed]);

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
          success ?? (label === "push" || label === "pull" ? result.output.split("\n").slice(-2).join(" ") || "Done." : null);
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
      commit: (repo: string, message: string, stagedCount: number) => {
        const stageAll = stagedCount === 0;
        return run(
          repo,
          "commit",
          () => rpc.call("commit", { environmentId, repo, message, stageAll }),
          stageAll ? "Committed all changes." : `Committed ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}.`,
        );
      },
      open: (repo: string, path: string) =>
        void navigate.experimental_openFilePreview({
          target: { kind: "workspace", environmentId, path: joinPath(repo, path) },
          location: null,
        }),
      select: (value: Selected) => setSelected(value),
    }),
    [run, rpc, environmentId, navigate],
  );

  if (selected !== null) {
    return <DiffPane rpc={rpc} environmentId={environmentId} selected={selected} onBack={() => setSelected(null)} />;
  }
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
        <div className="px-2 py-2">
          <div className="relative">
            <Icon
              name="FolderGit2"
              className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <select
              value={group}
              onChange={(event) => setChoice(event.target.value)}
              aria-label="Folder"
              className="h-8 w-full cursor-pointer appearance-none rounded-md border border-input bg-transparent pl-8 pr-8 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value={ALL}>
                All repositories ({repos.length})
              </option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label} · {g.members.length} repo{g.members.length === 1 ? "" : "s"}
                  {g.changes > 0 ? ` · ${g.changes} changed` : ""}
                </option>
              ))}
            </select>
            <Icon
              name="ChevronsUpDown"
              className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
          {workspace.truncated ? (
            <p className="mt-1 text-xs text-muted-foreground">Repository scan stopped early; some may be missing.</p>
          ) : null}
        </div>
      ) : null}
      <VirtualList
        items={items}
        getKey={keyOf}
        getHeight={heightOf}
        className="pb-2"
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
                  busy={repoBusy}
                  onToggle={toggleRepo}
                  onPush={actions.push}
                  onPull={actions.pull}
                />
              );
            case "commit":
              return (
                <CommitBox
                  key={`${environmentId}:${item.repo}`}
                  draftKey={`${environmentId}\u0000${item.repo}`}
                  repo={item.repo}
                  status={item.status}
                  busy={repoBusy}
                  notice={notices.get(item.repo) ?? null}
                  onCommit={actions.commit}
                  onStageAll={actions.stage}
                />
              );
            case "clean":
              return <p className="flex h-full items-center pl-8 text-xs text-muted-foreground">No changes.</p>;
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
  busy,
  onToggle,
  onPush,
  onPull,
}: {
  repo: string;
  label: string;
  status: Repo;
  expanded: boolean;
  busy: string | null;
  onToggle: (repo: string, current: boolean) => void;
  onPush: (repo: string) => void;
  onPull: (repo: string) => void;
}) {
  let add = 0;
  let del = 0;
  for (const f of status.files) {
    add += f.add ?? 0;
    del += f.del ?? 0;
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      title={`${repo === "" ? "." : repo}${status.upstream === null ? "" : ` → ${status.upstream}`}`}
      onClick={() => onToggle(repo, expanded)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle(repo, expanded);
        }
      }}
      className="mx-1 mt-1 flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-sm hover:bg-state-hover"
    >
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
      <Icon name="GitFork" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 shrink truncate font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {status.branch ?? "detached"}
      </span>
      {status.files.length > 0 ? (
        <span className="shrink-0 font-mono text-xs">
          <span className="text-diff-added">+{add}</span> <span className="text-diff-removed">-{del}</span>
        </span>
      ) : null}
      <button
        type="button"
        className="flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
        title="Pull (fast-forward only)"
        disabled={busy !== null || status.upstream === null}
        onClick={(event) => {
          event.stopPropagation();
          onPull(repo);
        }}
      >
        <Icon name={busy === "pull" ? "LoaderCircle" : "ArrowDown"} className={cn("size-3.5", busy === "pull" && "animate-spin")} />
        {status.behind}
      </button>
      <button
        type="button"
        className="flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
        title={status.upstream === null ? "Push and set upstream" : "Push"}
        disabled={busy !== null}
        onClick={(event) => {
          event.stopPropagation();
          onPush(repo);
        }}
      >
        <Icon name={busy === "push" ? "LoaderCircle" : "ArrowUp"} className={cn("size-3.5", busy === "push" && "animate-spin")} />
        {status.ahead}
      </button>
    </div>
  );
});

function CommitBox({
  draftKey,
  repo,
  status,
  busy,
  notice,
  onCommit,
  onStageAll,
}: {
  draftKey: string;
  repo: string;
  status: Repo;
  busy: string | null;
  notice: Notice | null;
  onCommit: (repo: string, message: string, stagedCount: number) => Promise<boolean>;
  onStageAll: (repo: string, paths: string[]) => void;
}) {
  const [message, setMessageState] = useState(() => drafts.get(draftKey) ?? "");
  const setMessage = (value: string) => {
    drafts.set(draftKey, value);
    setMessageState(value);
  };
  const stagedCount = status.files.filter(isStaged).length;
  const unstaged = status.files.filter(isUnstaged);
  const commit = async () => {
    const text = message.trim();
    if (text === "" || busy !== null) return;
    if (await onCommit(repo, text, stagedCount)) setMessage("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void commit();
    }
  };
  return (
    <div className="flex h-full flex-col gap-1.5 px-3 pb-1 pt-1.5">
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`Message (${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}+Enter to commit)`}
        className="h-[60px] w-full shrink-0 resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          className="h-7 flex-1"
          disabled={busy !== null || message.trim() === "" || status.files.length === 0}
          onClick={() => void commit()}
        >
          <Icon name={busy === "commit" ? "LoaderCircle" : "Check"} className={cn(busy === "commit" && "animate-spin")} />
          {stagedCount === 0 ? "Commit All" : "Commit"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1"
          disabled={busy !== null || unstaged.length === 0}
          onClick={() => onStageAll(repo, unstaged.map((c) => c.path))}
        >
          <Icon name="Plus" />
          Stage All
        </Button>
      </div>
      <p
        role={notice?.tone === "error" ? "alert" : "status"}
        title={notice?.text}
        className={cn(
          "h-4 shrink-0 truncate text-xs",
          notice?.tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {notice?.text ?? (status.truncated ? `Showing the first ${status.files.length} changes.` : "")}
      </p>
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
      className="ml-4 mr-1 flex h-full cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-state-hover hover:text-foreground"
    >
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
      <span>{section === "staged" ? "Staged" : "Changes"}</span>
      <span className="font-normal">{count}</span>
      <span className="flex-1" />
      {section === "staged" ? (
        <IconAction
          icon="Minus"
          title="Unstage all"
          disabled={disabled}
          onClick={() => onUnstage(repo, files.filter(isStaged).map((c) => c.path))}
        />
      ) : (
        <>
          <ConfirmButton
            icon="Undo2"
            title="Discard all changes"
            disabled={disabled}
            onConfirm={() => onDiscard(repo, files.filter(isUnstaged))}
          />
          <IconAction
            icon="Plus"
            title="Stage all"
            disabled={disabled}
            onClick={() => onStage(repo, files.filter(isUnstaged).map((c) => c.path))}
          />
        </>
      )}
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
  const select = () =>
    onSelect({ repo, path: change.path, staged: section === "staged", untracked: change.x === "?" });
  return (
    <div
      role="button"
      tabIndex={0}
      title={change.orig === null ? change.path : `${change.orig} → ${change.path}`}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter") select();
      }}
      className="group flex h-full cursor-pointer items-center gap-1.5 pl-9 pr-2 text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      <Icon name="File" className={cn("size-4 shrink-0", tone)} />
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
              icon="Undo2"
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

function DiffPane({
  rpc,
  environmentId,
  selected,
  onBack,
}: {
  rpc: Rpc;
  environmentId: string;
  selected: Selected;
  onBack: () => void;
}) {
  const [result, setResult] = useState<{ patch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.call("diff", { environmentId, ...selected }).then(
      (next) => {
        if (!cancelled) setResult(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, environmentId, selected]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const full = joinPath(selected.repo, selected.path);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="ArrowLeft" />
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={full}>
          {full}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {selected.untracked ? "untracked" : selected.staged ? "staged" : "working tree"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null ? (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        ) : result === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading diff…</p>
        ) : result.truncated ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">This diff is too large or binary to show.</p>
        ) : result.patch === "" ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No textual changes.</p>
        ) : (
          <Diff patch={result.patch} path={selected.path} />
        )}
      </div>
    </div>
  );
}
