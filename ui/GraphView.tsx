import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import type { Commit, WorkspaceStatus } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { DIFF_TAB_REFERENCE, commitTabTitle, type DiffParams } from "./DiffTab";
import { FolderPicker, type FolderOption } from "./FolderPicker";
import { VirtualList } from "./VirtualList";
import { errorMessage, useCachedState, type Rpc } from "./data";
import { layoutGraph, parseRefs, relativeTime, type GraphRow, type Ref } from "./graph";

const PAGE = 300;
const ROW = 46;
const LANE = 12;
const MAX_LANES = 12;
const LANE_HUES = [255, 25, 145, 300, 75, 195, 340, 110, 230, 50];

const repoChoice = new Map<string, string>();
const logCache = new Map<string, { commits: Commit[] | null; hasMore: boolean }>();
const scopeChoice = new Map<string, boolean>();

function laneColor(index: number): string {
  return `oklch(0.7 0.15 ${LANE_HUES[index % LANE_HUES.length] ?? 255})`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

function authorHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 33 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

type Item = { kind: "commit"; commit: Commit; row: GraphRow | null } | { kind: "more" };

export function GraphView({
  rpc,
  environmentId,
  workspace,
  signal,
}: {
  rpc: Rpc;
  environmentId: string;
  workspace: WorkspaceStatus | null;
  signal: number;
}) {
  const panel = experimental_useAppPanel();
  const repos = useMemo(
    () => (workspace?.repos ?? []).flatMap((r) => (r.status.repo ? [{ repo: r.repo, status: r.status }] : [])),
    [workspace],
  );
  const [choice, setChoiceState] = useState<string | null>(() => repoChoice.get(environmentId) ?? null);
  const repo = repos.find((r) => r.repo === choice) ?? repos.find((r) => r.repo === "") ?? repos[0] ?? null;
  const [all, setAllState] = useState(() => scopeChoice.get(environmentId) ?? true);
  const [query, setQuery] = useState("");
  const repoKey = repo?.repo ?? null;
  const [log, setLog] = useCachedState(logCache, `${environmentId}\u0000${repoKey ?? ""}\u0000${all}`, () => ({
    commits: null as Commit[] | null,
    hasMore: false,
  }));
  const commits = log.commits;
  const hasMore = log.hasMore;
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setChoice = (value: string) => {
    repoChoice.set(environmentId, value);
    setChoiceState(value);
  };
  const setAll = (value: boolean) => {
    scopeChoice.set(environmentId, value);
    setAllState(value);
  };

  const loadedCount = commits?.length ?? 0;
  useEffect(() => {
    if (repoKey === null) return;
    let cancelled = false;
    const limit = Math.min(500, Math.max(PAGE, loadedCount));
    rpc.call("log", { environmentId, repo: repoKey, all, skip: 0, limit }).then(
      (page) => {
        if (cancelled) return;
        setLog((prev) =>
          prev.commits !== null &&
          prev.hasMore === page.hasMore &&
          JSON.stringify(prev.commits) === JSON.stringify(page.commits)
            ? prev
            : { commits: page.commits, hasMore: page.hasMore },
        );
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, environmentId, repoKey, all, signal]);

  const loadMore = useCallback(() => {
    if (repoKey === null || commits === null || loadingMore) return;
    setLoadingMore(true);
    rpc
      .call("log", { environmentId, repo: repoKey, all, skip: commits.length, limit: PAGE })
      .then(
        (page) => setLog((prev) => ({ commits: [...(prev.commits ?? []), ...page.commits], hasMore: page.hasMore })),
        (cause: unknown) => setError(errorMessage(cause)),
      )
      .finally(() => setLoadingMore(false));
  }, [rpc, environmentId, repoKey, all, commits, loadingMore]);

  const graph = useMemo(() => layoutGraph(commits ?? []), [commits]);
  const needle = query.trim().toLowerCase();
  const items = useMemo<Item[]>(() => {
    if (commits === null) return [];
    const out: Item[] = [];
    commits.forEach((commit, index) => {
      if (
        needle !== "" &&
        !commit.subject.toLowerCase().includes(needle) &&
        !commit.author.toLowerCase().includes(needle) &&
        !commit.sha.startsWith(needle) &&
        !commit.refs.toLowerCase().includes(needle)
      ) {
        return;
      }
      out.push({ kind: "commit", commit, row: needle === "" ? (graph.rows[index] ?? null) : null });
    });
    if (hasMore && needle === "") out.push({ kind: "more" });
    return out;
  }, [commits, graph, needle, hasMore]);

  const lanes = needle === "" ? Math.min(graph.width, MAX_LANES) : 0;

  const options = useMemo<FolderOption[]>(
    () =>
      repos.map((r) => {
        const name = r.repo === "" ? (workspace?.name ?? "workspace") : r.repo.slice(r.repo.lastIndexOf("/") + 1);
        return {
          key: r.repo,
          title: name,
          path: r.repo === "" ? "workspace root" : r.repo,
          subtitle: `${r.status.branch ?? "detached"} · ${r.repo === "" ? "workspace root" : r.repo}`,
          repos: [r.repo, r.status.branch ?? ""],
          changes: r.status.files.length,
          all: false,
        };
      }),
    [repos, workspace?.name],
  );

  const openCommit = useCallback(
    (commit: Commit) => {
      if (repoKey === null) return;
      const params: DiffParams = { kind: "commit", repo: repoKey, sha: commit.sha, subject: commit.subject };
      if (!panel.openTab({ tab: DIFF_TAB_REFERENCE, params, title: commitTabTitle(params) })) {
        setError("Commit details open in a tab once the thread has started.");
      }
    },
    [panel, repoKey],
  );

  if (workspace === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  }
  if (repo === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No git repositories in this workspace.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {repos.length > 1 ? (
        <FolderPicker
          options={options}
          value={repo.repo}
          onChange={setChoice}
          placeholder="Search repositories"
          noun="repositories"
        />
      ) : null}
      <div className="flex items-center gap-2 px-2 pb-2 pt-1">
        <div className="flex shrink-0 rounded-md bg-secondary p-0.5 text-xs">
          {[
            { value: true, label: "All branches" },
            { value: false, label: repo.status.branch ?? "HEAD" },
          ].map((entry) => (
            <button
              key={String(entry.value)}
              type="button"
              aria-pressed={all === entry.value}
              title={entry.value ? "Show commits from every branch" : `Show only commits reachable from ${entry.label}`}
              onClick={() => setAll(entry.value)}
              className={cn(
                "flex max-w-[140px] items-center gap-1 truncate rounded px-2 py-1",
                all === entry.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.value ? null : <Icon name="GitBranch" className="size-3 shrink-0" />}
              <span className="truncate">{entry.label}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input px-2">
          <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            placeholder="Message, author, hash, branch"
            aria-label="Filter commits"
            className="h-7 min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      </div>
      {error !== null && commits !== null ? (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 border-t border-border">
        {error !== null && commits === null ? (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        ) : commits === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading commits…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {needle === "" ? "No commits yet." : `No loaded commits match “${query}”.`}
          </p>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <VirtualList
              items={items}
              getKey={(item) => (item.kind === "more" ? "more" : item.commit.sha)}
              getHeight={(item) => (item.kind === "more" ? 44 : ROW)}
              scrollKey={`graph:${environmentId}:${repoKey ?? ""}:${all}`}
              renderRow={(item) =>
                item.kind === "more" ? (
                  <div className="flex h-full items-center justify-center">
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      title="Load older commits"
                      className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
                    >
                      <Icon
                        name={loadingMore ? "Spinner" : "ChevronsDown"}
                        className={cn("size-3.5", loadingMore && "animate-spin")}
                      />
                      Load more commits
                    </button>
                  </div>
                ) : (
                  <CommitRow commit={item.commit} row={item.row} lanes={lanes} onOpen={openCommit} />
                )
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  commit,
  row,
  lanes,
  onOpen,
}: {
  commit: Commit;
  row: GraphRow | null;
  lanes: number;
  onOpen: (commit: Commit) => void;
}) {
  const refs = useMemo(() => parseRefs(commit.refs), [commit.refs]);
  const merge = commit.parents.length > 1;
  const hue = authorHue(commit.author);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(commit)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(commit);
      }}
      title={`${commit.sha}\n${commit.author} <${commit.email}>\n${new Date(commit.time * 1000).toLocaleString()}`}
      className="flex h-full items-center gap-2 pr-3 hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      {lanes > 0 ? <GraphCell row={row} lanes={lanes} merge={merge} /> : <span className="w-2 shrink-0" />}
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
        style={{ background: `oklch(0.7 0.12 ${hue} / 0.2)`, color: `oklch(0.75 0.12 ${hue})` }}
      >
        {initials(commit.author)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
        <span className="flex min-w-0 items-center gap-1.5">
          {refs.map((ref) => (
            <RefBadge key={`${ref.kind}:${ref.name}`} refInfo={ref} />
          ))}
          <span className={cn("min-w-0 truncate text-sm", merge && "text-muted-foreground")}>{commit.subject}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{commit.author}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 font-mono">{commit.sha.slice(0, 7)}</span>
          {merge ? <span className="shrink-0 rounded bg-secondary px-1 text-[10px] font-medium">M</span> : null}
          <span aria-hidden>·</span>
          <span className="shrink-0">{relativeTime(commit.time)}</span>
        </span>
      </span>
    </div>
  );
});

function RefBadge({ refInfo }: { refInfo: Ref }) {
  const icon = refInfo.kind === "tag" ? "Pin" : refInfo.kind === "remote" ? "Cloud" : "GitBranch";
  return (
    <span
      title={refInfo.kind === "head" ? `${refInfo.name} (checked out)` : refInfo.name}
      className={cn(
        "flex max-w-[140px] shrink-0 items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[11px]",
        refInfo.kind === "head"
          ? "border-[oklch(0.56_0.17_255)] bg-[oklch(0.56_0.17_255/0.15)] text-[oklch(0.72_0.14_255)]"
          : refInfo.kind === "tag"
            ? "border-warning/50 text-warning"
            : "border-border text-muted-foreground",
      )}
    >
      <Icon name={icon} className="size-3 shrink-0" />
      <span className="truncate">{refInfo.name}</span>
    </span>
  );
}

function GraphCell({ row, lanes, merge }: { row: GraphRow | null; lanes: number; merge: boolean }) {
  const width = lanes * LANE + 8;
  if (row === null) return <span className="shrink-0" style={{ width }} />;
  const x = (i: number) => 4 + Math.min(i, MAX_LANES - 1) * LANE + LANE / 2;
  const mid = ROW / 2;
  const path = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  return (
    <svg width={width} height={ROW} className="shrink-0 overflow-visible" aria-hidden>
      {row.top.map((s, i) => (
        <path
          key={`t${i}`}
          d={path(x(s.from), 0, x(s.to), mid)}
          stroke={laneColor(s.color)}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      ))}
      {row.bottom.map((s, i) => (
        <path
          key={`b${i}`}
          d={path(x(s.from), mid, x(s.to), ROW)}
          stroke={laneColor(s.color)}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      ))}
      <circle
        cx={x(row.column)}
        cy={mid}
        r={merge ? 3.5 : 4.5}
        fill={merge ? "var(--background)" : laneColor(row.color)}
        stroke={laneColor(row.color)}
        strokeWidth={merge ? 2 : 1.5}
      />
    </svg>
  );
}
