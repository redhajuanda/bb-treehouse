import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { experimental_Diff as Diff, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Change, Status } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { VirtualList } from "./VirtualList";
import { badgeClass, badgeOf, errorMessage, type Rpc } from "./data";

type Section = "staged" | "changes";

type Item =
  | { kind: "header"; section: Section; count: number }
  | { kind: "file"; section: Section; change: Change };

interface Selected {
  path: string;
  staged: boolean;
  untracked: boolean;
}

const drafts = new Map<string, string>();
const collapsedSections = new Map<string, Set<Section>>();

function isStaged(change: Change): boolean {
  return change.x !== " " && change.x !== "?";
}

function isUnstaged(change: Change): boolean {
  return change.y !== " " || change.x === "?";
}

function splitName(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

export function GitView({
  rpc,
  environmentId,
  status,
  statusError,
  reload,
}: {
  rpc: Rpc;
  environmentId: string;
  status: Status | null;
  statusError: string | null;
  reload: () => void;
}) {
  const navigate = useBbNavigate();
  const [message, setMessageState] = useState(() => drafts.get(environmentId) ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [collapsed, setCollapsed] = useState<Set<Section>>(
    () => collapsedSections.get(environmentId) ?? new Set(),
  );

  const setMessage = useCallback(
    (value: string) => {
      drafts.set(environmentId, value);
      setMessageState(value);
    },
    [environmentId],
  );

  const run = useCallback(
    async (label: string, action: () => Promise<{ output: string }>, success?: string) => {
      setBusy(label);
      setNotice(null);
      try {
        const result = await action();
        if (success !== undefined) setNotice({ tone: "info", text: success });
        else if (label === "push" || label === "pull") {
          setNotice({ tone: "info", text: result.output.split("\n").slice(-2).join(" ") || "Done." });
        }
        return true;
      } catch (cause) {
        setNotice({ tone: "error", text: errorMessage(cause) });
        return false;
      } finally {
        setBusy(null);
        reload();
      }
    },
    [reload],
  );

  const repo = status !== null && status.repo ? status : null;
  const files = repo?.files ?? [];
  const staged = useMemo(() => files.filter(isStaged), [files]);
  const unstaged = useMemo(() => files.filter(isUnstaged), [files]);

  const items = useMemo(() => {
    const out: Item[] = [];
    const push = (section: Section, list: Change[]) => {
      if (list.length === 0) return;
      out.push({ kind: "header", section, count: list.length });
      if (collapsed.has(section)) return;
      for (const change of list) out.push({ kind: "file", section, change });
    };
    push("staged", staged);
    push("changes", unstaged);
    return out;
  }, [staged, unstaged, collapsed]);

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.add ?? 0;
      del += f.del ?? 0;
    }
    return { add, del };
  }, [files]);

  const toggleSection = useCallback(
    (section: Section) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(section)) next.delete(section);
        else next.add(section);
        collapsedSections.set(environmentId, next);
        return next;
      });
    },
    [environmentId],
  );

  const stage = useCallback(
    (paths: string[]) => run("stage", () => rpc.call("stage", { environmentId, paths })),
    [rpc, environmentId, run],
  );
  const unstage = useCallback(
    (paths: string[]) => run("unstage", () => rpc.call("unstage", { environmentId, paths })),
    [rpc, environmentId, run],
  );
  const discard = useCallback(
    (changes: Change[]) => {
      const tracked: string[] = [];
      const untracked: string[] = [];
      for (const c of changes) {
        if (c.x === "?" || c.x === "A") untracked.push(c.path);
        else tracked.push(c.path);
      }
      return run("discard", () => rpc.call("discard", { environmentId, tracked, untracked }));
    },
    [rpc, environmentId, run],
  );
  const openFile = useCallback(
    (path: string) =>
      navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId, path },
        location: null,
      }),
    [navigate, environmentId],
  );

  const commit = useCallback(async () => {
    const text = message.trim();
    if (text === "" || busy !== null) return;
    const stageAll = staged.length === 0;
    const ok = await run(
      "commit",
      () => rpc.call("commit", { environmentId, message: text, stageAll }),
      stageAll ? "Committed all changes." : `Committed ${staged.length} staged file${staged.length === 1 ? "" : "s"}.`,
    );
    if (ok) setMessage("");
  }, [message, busy, staged.length, run, rpc, environmentId, setMessage]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void commit();
    }
  };

  if (selected !== null) {
    return <DiffPane rpc={rpc} environmentId={environmentId} selected={selected} onBack={() => setSelected(null)} />;
  }
  if (status === null) {
    return (
      <p className={cn("px-4 py-3 text-sm", statusError === null ? "text-muted-foreground" : "text-destructive")}>
        {statusError ?? "Loading…"}
      </p>
    );
  }
  if (repo === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">This workspace is not a git repository.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b border-border px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <Icon name="GitBranch" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono">{repo.branch ?? "(detached HEAD)"}</span>
          <span className="shrink-0 font-mono text-xs">
            <span className="text-diff-added">+{totals.add.toLocaleString()}</span>{" "}
            <span className="text-diff-removed">-{totals.del.toLocaleString()}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="ArrowRight" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{repo.upstream ?? "no upstream"}</span>
          <button
            type="button"
            className="flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-xs hover:bg-state-hover hover:text-foreground disabled:opacity-50"
            title="Pull (fast-forward only)"
            disabled={busy !== null || repo.upstream === null}
            onClick={() => void run("pull", () => rpc.call("pull", { environmentId }))}
          >
            <Icon name={busy === "pull" ? "LoaderCircle" : "ArrowDown"} className={cn("size-3.5", busy === "pull" && "animate-spin")} />
            {repo.behind}
          </button>
          <button
            type="button"
            className="flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-xs hover:bg-state-hover hover:text-foreground disabled:opacity-50"
            title={repo.upstream === null ? "Push and set upstream" : "Push"}
            disabled={busy !== null}
            onClick={() => void run("push", () => rpc.call("push", { environmentId }))}
          >
            <Icon name={busy === "push" ? "LoaderCircle" : "ArrowUp"} className={cn("size-3.5", busy === "push" && "animate-spin")} />
            {repo.ahead}
          </button>
        </div>
      </div>

      <div className="space-y-2 px-3 py-2">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message (${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}+Enter to commit)`}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={busy !== null || message.trim() === "" || files.length === 0}
            onClick={() => void commit()}
          >
            <Icon name={busy === "commit" ? "LoaderCircle" : "Check"} className={cn(busy === "commit" && "animate-spin")} />
            {staged.length === 0 ? "Commit All" : "Commit"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={busy !== null || unstaged.length === 0}
            onClick={() => void stage(unstaged.map((c) => c.path))}
          >
            <Icon name="Plus" />
            Stage All
          </Button>
        </div>
        {notice === null ? null : (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "whitespace-pre-wrap break-words text-xs",
              notice.tone === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {notice.text}
          </p>
        )}
        {repo.truncated ? (
          <p className="text-xs text-muted-foreground">Showing the first {files.length.toLocaleString()} changes.</p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No changes.</p>
      ) : (
        <VirtualList
          items={items}
          getKey={(item) => (item.kind === "header" ? `h:${item.section}` : `${item.section}:${item.change.path}`)}
          className="pb-2"
          renderRow={(item) =>
            item.kind === "header" ? (
              <SectionHeader
                section={item.section}
                count={item.count}
                collapsed={collapsed.has(item.section)}
                disabled={busy !== null}
                onToggle={toggleSection}
                onStageAll={() => void stage(unstaged.map((c) => c.path))}
                onUnstageAll={() => void unstage(staged.map((c) => c.path))}
                onDiscardAll={() => void discard(unstaged)}
              />
            ) : (
              <FileRow
                change={item.change}
                section={item.section}
                disabled={busy !== null}
                onSelect={setSelected}
                onOpen={openFile}
                onStage={stage}
                onUnstage={unstage}
                onDiscard={discard}
              />
            )
          }
        />
      )}
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
        "flex size-6 shrink-0 items-center justify-center rounded hover:bg-state-hover disabled:opacity-50",
        armed ? "bg-destructive text-destructive-foreground hover:bg-destructive" : "text-muted-foreground hover:text-foreground",
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
  section,
  count,
  collapsed,
  disabled,
  onToggle,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
}: {
  section: Section;
  count: number;
  collapsed: boolean;
  disabled: boolean;
  onToggle: (section: Section) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggle(section)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle(section);
        }
      }}
      className="group mx-1 flex h-full cursor-pointer items-center gap-1 rounded-md bg-secondary px-2 text-xs font-semibold uppercase tracking-wide"
    >
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
      <span>{section === "staged" ? "Staged" : "Changes"}</span>
      <span className="font-normal text-muted-foreground">{count}</span>
      <span className="flex-1" />
      {section === "staged" ? (
        <IconAction icon="Minus" title="Unstage all" disabled={disabled} onClick={onUnstageAll} />
      ) : (
        <>
          <ConfirmButton icon="Undo2" title="Discard all changes" disabled={disabled} onConfirm={onDiscardAll} />
          <IconAction icon="Plus" title="Stage all" disabled={disabled} onClick={onStageAll} />
        </>
      )}
    </div>
  );
});

const FileRow = memo(function FileRow({
  change,
  section,
  disabled,
  onSelect,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
}: {
  change: Change;
  section: Section;
  disabled: boolean;
  onSelect: (selected: Selected) => void;
  onOpen: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (changes: Change[]) => void;
}) {
  const badge = badgeOf(change);
  const tone = badgeClass(badge);
  const { name, dir } = splitName(change.path);
  const deleted = badge === "D";
  return (
    <div
      role="button"
      tabIndex={0}
      title={change.orig === null ? change.path : `${change.orig} → ${change.path}`}
      onClick={() =>
        onSelect({ path: change.path, staged: section === "staged", untracked: change.x === "?" })
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect({ path: change.path, staged: section === "staged", untracked: change.x === "?" });
      }}
      className="group flex h-full cursor-pointer items-center gap-1.5 pl-5 pr-2 text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      <Icon name="File" className={cn("size-4 shrink-0", tone)} />
      <span className={cn("shrink-0", deleted && "line-through")}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
        {deleted ? null : <IconAction icon="FileText" title="Open file" disabled={false} onClick={() => onOpen(change.path)} />}
        {section === "staged" ? (
          <IconAction icon="Minus" title="Unstage" disabled={disabled} onClick={() => onUnstage([change.path])} />
        ) : (
          <>
            <ConfirmButton icon="Undo2" title="Discard changes" disabled={disabled} onConfirm={() => onDiscard([change])} />
            <IconAction icon="Plus" title="Stage" disabled={disabled} onClick={() => onStage([change.path])} />
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="ArrowLeft" />
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={selected.path}>
          {selected.path}
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
