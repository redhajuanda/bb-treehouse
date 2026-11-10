import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { DirEntry } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { VirtualList } from "./VirtualList";
import { badgeClass, errorMessage, type Badge, type BadgeIndex, type Rpc } from "./data";

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
}: {
  rpc: Rpc;
  environmentId: string;
  badges: BadgeIndex;
  signal: number;
  query: string;
  collapseSignal: number;
}) {
  const navigate = useBbNavigate();
  const [dirs, setDirs] = useState<Map<string, DirEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedFor(environmentId)));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Map<string, Promise<void>>());

  const load = useCallback(
    (rel: string) => {
      const running = inflight.current.get(rel);
      if (running !== undefined) return running;
      setLoading((prev) => new Set(prev).add(rel));
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
            if (rel === "") setError(errorMessage(cause));
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
    [rpc, environmentId],
  );

  useEffect(() => {
    void load("");
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

  const open = useCallback(
    (rel: string) => {
      navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId, path: rel },
        location: null,
      });
    },
    [navigate, environmentId],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (rel: string, depth: number) => {
      const entries = dirs.get(rel);
      if (entries === undefined) return;
      for (const entry of entries) {
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
    walk("", 0);
    return out;
  }, [dirs, expanded, loading]);

  if (query.trim() !== "") {
    return <SearchResults rpc={rpc} environmentId={environmentId} query={query} badges={badges} onOpen={open} />;
  }
  if (error !== null && !dirs.has("")) {
    return <p className="px-4 py-3 text-sm text-destructive">{error}</p>;
  }
  if (!dirs.has("")) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  }
  return (
    <VirtualList
      items={rows}
      getKey={(row) => row.path}
      className="py-1"
      renderRow={(row) => (
        <TreeRow
          row={row}
          badge={row.dir ? badges.dirs.get(row.path) : badges.files.get(row.path)}
          onToggle={toggle}
          onOpen={open}
        />
      )}
    />
  );
}

const TreeRow = memo(function TreeRow({
  row,
  badge,
  onToggle,
  onOpen,
}: {
  row: Row;
  badge: Badge | undefined;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const tone = badge === undefined ? undefined : badgeClass(badge);
  return (
    <button
      type="button"
      title={row.path}
      onClick={() => (row.dir ? onToggle(row.path) : onOpen(row.path))}
      className={cn(
        "flex h-full w-full items-center gap-1.5 pr-3 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
        row.ignored && "text-muted-foreground italic",
      )}
      style={{ paddingLeft: 8 + row.depth * 14 }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {row.dir ? (
          <Icon
            name={row.loading ? "LoaderCircle" : row.expanded ? "ChevronDown" : "ChevronRight"}
            className={cn("size-3.5", row.loading && "animate-spin")}
          />
        ) : null}
      </span>
      <Icon
        name={row.dir ? (row.expanded ? "FolderOpen" : "Folder") : "File"}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className={cn("min-w-0 flex-1 truncate", tone)}>{row.name}</span>
      {row.ignored ? (
        <Icon name="Ban" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : badge !== undefined ? (
        <span className={cn("shrink-0 text-xs font-semibold", tone)}>{badge}</span>
      ) : null}
    </button>
  );
});

function SearchResults({
  rpc,
  environmentId,
  query,
  badges,
  onOpen,
}: {
  rpc: Rpc;
  environmentId: string;
  query: string;
  badges: BadgeIndex;
  onOpen: (path: string) => void;
}) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("search", { environmentId, query: query.trim() }).then(
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
  }, [rpc, environmentId, query]);

  if (error !== null) return <p className="px-4 py-3 text-sm text-destructive">{error}</p>;
  if (paths === null) return <p className="px-4 py-3 text-sm text-muted-foreground">Searching…</p>;
  if (paths.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">No matching files.</p>;
  return (
    <VirtualList
      items={paths}
      getKey={(p) => p}
      className="py-1"
      renderRow={(p) => {
        const slash = p.lastIndexOf("/");
        const badge = badges.files.get(p);
        const tone = badge === undefined ? undefined : badgeClass(badge);
        return (
          <button
            type="button"
            title={p}
            onClick={() => onOpen(p)}
            className="flex h-full w-full items-center gap-1.5 px-3 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
          >
            <Icon name="File" className="size-4 shrink-0 text-muted-foreground" />
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
