import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DirEntry } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { VirtualList } from "./VirtualList";
import { FileIcon } from "./FileIcon";
import { EntryContextMenu, useEntryActions, type EntryTarget } from "./EntryMenu";
import { badgeClass, errorMessage, type Badge, type BadgeIndex, type Rpc, useCachedState } from "./data";

const TREE_ROW_HEIGHT = 28;
const INDENT = 16;
const treeRowHeight = () => TREE_ROW_HEIGHT;

interface Row {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
  ignored: boolean;
  expanded: boolean;
  loading: boolean;
}

const treeState = new Map<string, Set<string>>();
const dirsCache = new Map<string, Map<string, DirEntry[]>>();
const searchCache = new Map<string, string[] | null>();

function expandedFor(environmentId: string): Set<string> {
  let set = treeState.get(environmentId);
  if (set === undefined) {
    set = new Set();
    treeState.set(environmentId, set);
  }
  return set;
}

export function NamesView({
  rpc,
  environmentId,
  badges,
  signal,
  query,
  collapseSignal,
  base,
  hideIgnored,
  rootPath,
  onOpenFile,
  selectedPath,
  onEntryMoved,
}: {
  rpc: Rpc;
  environmentId: string;
  badges: BadgeIndex;
  signal: number;
  query: string;
  collapseSignal: number;
  base: string;
  hideIgnored: boolean;
  rootPath: string | null;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  onEntryMoved: (from: string, to: string | null) => void;
}) {
  const [dirs, setDirs] = useCachedState(dirsCache, environmentId, () => new Map<string, DirEntry[]>());
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedFor(environmentId)));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Map<string, Promise<void>>());

  const load = useCallback(
    (rel: string) => {
      const running = inflight.current.get(rel);
      if (running !== undefined) return running;
      if (!dirsRef.current.has(rel)) setLoading((prev) => new Set(prev).add(rel));
      const promise = rpc
        .call("listDir", { environmentId, rel })
        .then(
          (result) => {
            setDirs((prev) => {
              const old = prev.get(rel);
              if (old !== undefined && JSON.stringify(old) === JSON.stringify(result.entries)) return prev;
              const next = new Map(prev);
              next.set(rel, result.entries);
              return next;
            });
            setError(null);
          },
          (cause: unknown) => {
            if (rel === base) setError(errorMessage(cause));
            setExpanded((prev) => {
              if (!prev.has(rel)) return prev;
              const next = new Set(prev);
              next.delete(rel);
              return next;
            });
          },
        )
        .finally(() => {
          inflight.current.delete(rel);
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(rel);
            return next;
          });
        });
      inflight.current.set(rel, promise);
      return promise;
    },
    [rpc, environmentId, base],
  );

  useEffect(() => {
    void load(base);
    for (const rel of expanded) void load(rel);
  }, [load, signal]);

  useEffect(() => {
    if (collapseSignal === 0) return;
    setExpanded(new Set());
  }, [collapseSignal]);

  useEffect(() => {
    treeState.set(environmentId, expanded);
  }, [environmentId, expanded]);

  const toggle = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
          void load(rel);
        }
        return next;
      });
    },
    [load],
  );

  const open = onOpenFile;

  const onChanged = useCallback(
    ({ parent, path, removed }: { parent: string; path: string | null; removed?: string }) => {
      void load(parent);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (removed !== undefined) {
          for (const rel of prev) if (rel === removed || rel.startsWith(`${removed}/`)) next.delete(rel);
        }
        if (parent !== base) next.add(parent);
        return next;
      });
      if (path !== null) setFocusPath(path);
      if (removed !== undefined) onEntryMoved(removed, path);
    },
    [load, base, onEntryMoved],
  );
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const { actions, handleKey, dialogs } = useEntryActions({
    rpc,
    environmentId,
    rootPath,
    openFile: onOpenFile,
    onChanged,
  });
  const onRowKey = useCallback(
    (event: KeyboardEvent, target: EntryTarget) => {
      if (handleKey(event, target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [handleKey],
  );
  const fallback = useMemo<EntryTarget>(() => ({ path: base, dir: true }), [base]);
  const withMenu = (content: ReactNode) => (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <EntryContextMenu environmentId={environmentId} actions={actions} fallback={fallback}>
        {content}
      </EntryContextMenu>
      {dialogs}
    </div>
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (rel: string, depth: number) => {
      const entries = dirs.get(rel);
      if (entries === undefined) return;
      for (const entry of entries) {
        if (hideIgnored && entry.ignored) continue;
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const isOpen = entry.dir && expanded.has(path);
        out.push({
          path,
          name: entry.name,
          depth,
          dir: entry.dir,
          ignored: entry.ignored,
          expanded: isOpen,
          loading: loading.has(path),
        });
        if (isOpen) walk(path, depth + 1);
      }
    };
    walk(base, 0);
    return out;
  }, [dirs, expanded, loading, base, hideIgnored]);

  if (query.trim() !== "") {
    return withMenu(
      <SearchResults
        rpc={rpc}
        environmentId={environmentId}
        base={base}
        query={query}
        badges={badges}
        onOpen={open}
        onKey={onRowKey}
      />,
    );
  }
  if (error !== null && !dirs.has(base)) {
    return <p className="px-4 py-3 text-sm text-destructive">{error}</p>;
  }
  if (!dirs.has(base)) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  }
  if (rows.length === 0) {
    const scratch = rootPath !== null && rootPath.includes("/environment-personal-workspace/");
    return withMenu(
      <div className="flex-1 px-4 py-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">This folder is empty.</p>
        {rootPath === null ? null : (
          <p className="mt-1 break-all font-mono text-xs" title={rootPath}>
            {base === "" ? rootPath : `${rootPath}/${base}`}
          </p>
        )}
        {scratch ? (
          <p className="mt-3">
            Threads without a project run in their own empty scratch folder, not your home folder. Files the agent
            creates here will show up as it works. To browse a repository, start the thread in a project.
          </p>
        ) : hideIgnored ? (
          <p className="mt-3">Ignored files are hidden; the eye button shows them.</p>
        ) : null}
        <p className="mt-3 text-xs">Right-click to create a file or folder.</p>
      </div>,
    );
  }
  return withMenu(
    <VirtualList
      items={rows}
      getKey={(row) => row.path}
      getHeight={treeRowHeight}
      className="px-1 py-1"
      scrollKey={`files:${environmentId}:${base}`}
      renderRow={(row) => (
        <TreeRow
          row={row}
          badge={row.dir ? badges.dirs.get(row.path) : badges.files.get(row.path)}
          onToggle={toggle}
          onOpen={open}
          onKey={onRowKey}
          selected={!row.dir && selectedPath === row.path}
          focus={focusPath === row.path}
          onFocused={() => setFocusPath(null)}
        />
      )}
    />,
  );
}

const TreeRow = memo(function TreeRow({
  row,
  badge,
  onToggle,
  onOpen,
  onKey,
  selected,
  focus,
  onFocused,
}: {
  row: Row;
  badge: Badge | undefined;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onKey: (event: KeyboardEvent, target: EntryTarget) => void;
  selected: boolean;
  focus: boolean;
  onFocused: () => void;
}) {
  const tone = badge === undefined ? undefined : badgeClass(badge);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: "nearest" });
    onFocused();
  }, [focus, onFocused]);
  return (
    <button
      ref={ref}
      type="button"
      title={row.path}
      data-entry-path={row.path}
      data-entry-dir={row.dir}
      onKeyDown={(event) => onKey(event, { path: row.path, dir: row.dir })}
      onClick={() => (row.dir ? onToggle(row.path) : onOpen(row.path))}
      className={cn(
        "relative flex h-full w-full items-center gap-1.5 rounded-md pr-3 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
        selected && "bg-state-active hover:bg-state-active",
        row.ignored && "opacity-55",
      )}
      style={{ paddingLeft: 6 + row.depth * INDENT }}
    >
      {Array.from({ length: row.depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-border"
          style={{ left: 6 + level * INDENT + 7 }}
        />
      ))}
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {row.dir ? (
          <Icon
            name={row.loading ? "Spinner" : row.expanded ? "ChevronDown" : "ChevronRight"}
            className={cn("size-3.5", row.loading && "animate-spin")}
          />
        ) : null}
      </span>
      <FileIcon name={row.name} dir={row.dir} open={row.expanded} className="size-[18px]" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          row.dir && "font-medium",
          row.ignored && "italic",
          tone ?? (row.dir ? "text-foreground" : "text-foreground/90"),
        )}
      >
        {row.name}
      </span>
      {row.ignored ? (
        <Icon name="Unavailable" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : badge !== undefined ? (
        <span className={cn("shrink-0 text-xs font-semibold", tone)}>{badge}</span>
      ) : null}
    </button>
  );
});

function SearchResults({
  rpc,
  environmentId,
  base,
  query,
  badges,
  onOpen,
  onKey,
}: {
  rpc: Rpc;
  environmentId: string;
  base: string;
  query: string;
  badges: BadgeIndex;
  onOpen: (path: string) => void;
  onKey: (event: KeyboardEvent, target: EntryTarget) => void;
}) {
  const [paths, setPaths] = useCachedState(
    searchCache,
    `${environmentId}\u0000${base}\u0000${query.trim()}`,
    () => null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("search", { environmentId, base, query: query.trim() }).then(
        (result) => {
          if (!cancelled) {
            setPaths(result.paths);
            setError(null);
          }
        },
        (cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        },
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, environmentId, base, query]);

  if (error !== null) return <p className="px-4 py-3 text-sm text-destructive">{error}</p>;
  if (paths === null) return <p className="px-4 py-3 text-sm text-muted-foreground">Searching…</p>;
  if (paths.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">No matching files.</p>;
  return (
    <VirtualList
      items={paths}
      getKey={(p) => p}
      getHeight={treeRowHeight}
      className="px-1 py-1"
      renderRow={(p) => {
        const slash = p.lastIndexOf("/");
        const badge = badges.files.get(p);
        const tone = badge === undefined ? undefined : badgeClass(badge);
        return (
          <button
            type="button"
            title={p}
            data-entry-path={p}
            data-entry-dir={false}
            onKeyDown={(event) => onKey(event, { path: p, dir: false })}
            onClick={() => onOpen(p)}
            className="flex h-full w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
          >
            <FileIcon name={p.slice(slash + 1)} className="size-[18px]" />
            <span className={cn("shrink-0", tone)}>{p.slice(slash + 1)}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {slash === -1 ? "" : p.slice(0, slash)}
            </span>
            {badge === undefined ? null : <span className={cn("shrink-0 text-xs font-semibold", tone)}>{badge}</span>}
          </button>
        );
      }}
    />
  );
}
