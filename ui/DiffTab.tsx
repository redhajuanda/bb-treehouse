import { useEffect, useState } from "react";
import type { CommitDetail, CommitFile } from "../contract";
import { cn } from "@/lib/utils";
import { relativeTime } from "./graph";
import { splitHunks } from "./hunks";
import { z } from "zod";
import {
  experimental_Diff as Diff,
  useBbNavigate,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { FileIcon } from "./FileIcon";
import { errorMessage, useCachedState, useRefreshSignal, useTreehouseRpc, useWatchLease } from "./data";

const diffCache = new Map<string, { patch: string; truncated: boolean } | null>();
const commitCache = new Map<string, CommitDetail | null>();
const commitCollapsedCache = new Map<string, Set<string> | null>();

export const DIFF_TAB_REFERENCE = { id: "diff", context: { kind: "thread" }, availability: "action" } as const;

const fileParamsSchema = z.object({
  kind: z.literal("file").optional(),
  repo: z.string(),
  path: z.string().min(1),
  staged: z.boolean(),
  untracked: z.boolean(),
});
const commitParamsSchema = z.object({
  kind: z.literal("commit"),
  repo: z.string(),
  sha: z.string().regex(/^[0-9a-f]{4,40}$/iu),
  subject: z.string(),
});
const compareParamsSchema = z.object({
  kind: z.literal("compare"),
  repo: z.string(),
  base: z.string().min(1),
  path: z.string().min(1),
});
export const diffParamsSchema = z.union([commitParamsSchema, compareParamsSchema, fileParamsSchema]);
export type FileDiffParams = z.infer<typeof fileParamsSchema>;
export type CommitParams = z.infer<typeof commitParamsSchema>;
export type CompareDiffParams = z.infer<typeof compareParamsSchema>;
export type DiffParams = FileDiffParams | CommitParams | CompareDiffParams;

export function compareTabTitle(params: CompareDiffParams): string {
  return `${params.path.slice(params.path.lastIndexOf("/") + 1)} (vs ${params.base})`;
}

export function diffTabTitle(params: FileDiffParams): string {
  const name = params.path.slice(params.path.lastIndexOf("/") + 1);
  return params.staged ? `${name} (staged)` : name;
}

export function commitTabTitle(params: CommitParams): string {
  const subject = params.subject.length > 32 ? `${params.subject.slice(0, 31)}…` : params.subject;
  return `${params.sha.slice(0, 7)} ${subject}`;
}

export function DiffTab({ environment, params }: ExperimentalThreadActionTabProps) {
  const parsed = diffParamsSchema.safeParse(params);
  if (environment === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">This thread has no workspace.</p>;
  }
  if (!parsed.success) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Pick a changed file in Treehouse's Git view to see its diff here.
      </p>
    );
  }
  const value = parsed.data;
  if (value.kind === "commit") {
    return <CommitView key={environment.id} environmentId={environment.id} params={value} />;
  }
  return <DiffView key={environment.id} environmentId={environment.id} params={value} />;
}

function DiffView({ environmentId, params }: { environmentId: string; params: FileDiffParams | CompareDiffParams }) {
  const rpc = useTreehouseRpc();
  const navigate = useBbNavigate();
  const watching = useWatchLease(rpc, environmentId);
  const signal = useRefreshSignal(environmentId, { poll: watching === false });
  const [result, setResult] = useCachedState(diffCache, `${environmentId}\u0000${JSON.stringify(params)}`, () => null);
  const [error, setError] = useState<string | null>(null);
  const { repo, path } = params;
  const compareBase = params.kind === "compare" ? params.base : null;
  const staged = params.kind === "compare" ? false : params.staged;
  const untracked = params.kind === "compare" ? false : params.untracked;

  useEffect(() => {
    let cancelled = false;
    const request =
      compareBase !== null
        ? rpc.call("compareDiff", { environmentId, repo, base: compareBase, path })
        : rpc.call("diff", { environmentId, repo, path, staged, untracked });
    request.then(
      (next) => {
        if (cancelled) return;
        setResult((prev) =>
          prev !== null && prev.patch === next.patch && prev.truncated === next.truncated ? prev : next,
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
  }, [rpc, environmentId, repo, path, staged, untracked, compareBase, signal]);

  const full = repo === "" ? path : `${repo}/${path}`;
  const slash = full.lastIndexOf("/");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileIcon name={full.slice(slash + 1)} className="size-[18px]" />
        <span className="min-w-0 flex-1 truncate text-sm" title={full}>
          <span className="font-medium">{full.slice(slash + 1)}</span>
          {slash === -1 ? null : <span className="ml-2 text-xs text-muted-foreground">{full.slice(0, slash)}</span>}
        </span>
        <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          {compareBase !== null ? `vs ${compareBase}` : untracked ? "untracked" : staged ? "staged" : "working tree"}
        </span>
        <button
          type="button"
          title="Open file"
          onClick={() =>
            navigate.experimental_openFilePreview({
              target: { kind: "workspace", environmentId, path: full },
              location: null,
            })
          }
          className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="FileText" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null ? (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        ) : result === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading diff…</p>
        ) : result.truncated ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">This diff is too large or binary to show.</p>
        ) : result.patch === "" ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No changes left in this file.</p>
        ) : (
          <HunkList
            patch={result.patch}
            path={path}
            mode={compareBase !== null || untracked ? null : staged ? "staged" : "worktree"}
            onApply={(patch, action) => rpc.call("applyHunk", { environmentId, repo, patch, mode: action })}
          />
        )}
      </div>
    </div>
  );
}

const EXPANDED_BY_DEFAULT = 8;

function CommitView({ environmentId, params }: { environmentId: string; params: CommitParams }) {
  const rpc = useTreehouseRpc();
  const cacheKey = `${environmentId}\u0000${params.repo}\u0000${params.sha}`;
  const [detail, setDetail] = useCachedState(commitCache, cacheKey, () => null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useCachedState(commitCollapsedCache, cacheKey, () => null);
  const { repo, sha } = params;

  useEffect(() => {
    if (detail !== null && collapsed !== null) return;
    let cancelled = false;
    rpc.call("show", { environmentId, repo, sha }).then(
      (next) => {
        if (cancelled) return;
        setDetail(next);
        setCollapsed(new Set(next.files.slice(EXPANDED_BY_DEFAULT).map((f) => f.path)));
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, environmentId, repo, sha]);

  if (error !== null) return <p className="px-4 py-3 text-sm text-destructive">{error}</p>;
  if (detail === null || collapsed === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Loading commit…</p>;
  }
  let add = 0;
  let del = 0;
  for (const f of detail.files) {
    add += f.add ?? 0;
    del += f.del ?? 0;
  }
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold leading-snug">{detail.subject}</h2>
        {detail.body === "" ? null : (
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{detail.body}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{detail.author}</span>
          <span aria-hidden>·</span>
          <span title={new Date(detail.time * 1000).toLocaleString()}>{relativeTime(detail.time)}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            title="Copy full hash"
            onClick={() => void navigator.clipboard?.writeText(detail.sha)}
            className="flex items-center gap-1 rounded px-1 font-mono hover:bg-state-hover hover:text-foreground"
          >
            {detail.sha.slice(0, 10)}
            <Icon name="Copy" className="size-3" />
          </button>
          {detail.parents.length > 1 ? (
            <span className="rounded bg-secondary px-1.5">merge · diff against first parent</span>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed{" "}
          {add > 0 ? <span className="font-mono text-diff-added">+{add} </span> : null}
          {del > 0 ? <span className="font-mono text-diff-removed">-{del}</span> : null}
          {detail.truncated ? " · list truncated" : ""}
        </div>
      </div>
      {detail.files.map((file) => (
        <CommitFileSection
          key={file.path}
          file={file}
          open={!collapsed.has(file.path)}
          onToggle={() => toggle(file.path)}
        />
      ))}
    </div>
  );
}

function CommitFileSection({ file, open, onToggle }: { file: CommitFile; open: boolean; onToggle: () => void }) {
  const slash = file.path.lastIndexOf("/");
  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "sticky top-0 z-10 flex w-full items-center gap-2 bg-background px-3 py-1.5 text-left text-sm hover:bg-state-hover",
          open && "border-b border-border",
        )}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
        <FileIcon name={file.path.slice(slash + 1)} />
        <span className="shrink-0 font-medium">{file.path.slice(slash + 1)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {slash === -1 ? "" : file.path.slice(0, slash)}
        </span>
        <span className="shrink-0 font-mono text-xs">
          {file.add === null ? <span className="text-muted-foreground">binary</span> : null}
          {file.add !== null && file.add > 0 ? <span className="text-diff-added">+{file.add}</span> : null}
          {file.del !== null && file.del > 0 ? <span className="text-diff-removed"> -{file.del}</span> : null}
        </span>
      </button>
      {open ? (
        file.truncated ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">This diff is too large to show.</p>
        ) : /^Binary files|^GIT binary patch/mu.test(file.patch) || !file.patch.includes("@@") ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No textual diff (binary, mode change or rename only).
          </p>
        ) : (
          <Diff patch={file.patch} path={file.path} />
        )
      ) : null}
    </section>
  );
}

type HunkAction = "stage" | "unstage" | "discard";

function HunkList({
  patch,
  path,
  mode,
  onApply,
}: {
  patch: string;
  path: string;
  mode: "worktree" | "staged" | null;
  onApply: (patch: string, action: HunkAction) => Promise<unknown>;
}) {
  const hunks = splitHunks(patch);
  const [pending, setPending] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  if (mode === null || hunks.length === 0) return <Diff patch={patch} path={path} />;
  const apply = async (index: number, action: HunkAction) => {
    const hunk = hunks[index];
    if (hunk === undefined) return;
    setPending(index);
    setError(null);
    try {
      await onApply(hunk.patch, action);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
      setArmed(null);
    }
  };
  const button =
    "flex h-6 items-center gap-1 rounded-md px-2 text-xs hover:bg-state-hover hover:text-foreground disabled:opacity-50";
  return (
    <div>
      {error === null ? null : (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {hunks.map((hunk, index) => (
        <section key={`${index}:${hunk.header}`} className="border-b border-border">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{hunk.header}</span>
            {mode === "worktree" ? (
              <>
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => (armed === index ? void apply(index, "discard") : setArmed(index))}
                  className={cn(
                    button,
                    armed === index
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <Icon name={armed === index ? "Check" : "RotateCcw"} className="size-3.5" />
                  {armed === index ? "Confirm discard" : "Discard"}
                </button>
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void apply(index, "stage")}
                  className={cn(button, "text-muted-foreground")}
                >
                  <Icon
                    name={pending === index ? "Spinner" : "Plus"}
                    className={cn("size-3.5", pending === index && "animate-spin")}
                  />
                  Stage hunk
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void apply(index, "unstage")}
                className={cn(button, "text-muted-foreground")}
              >
                <Icon
                  name={pending === index ? "Spinner" : "Minus"}
                  className={cn("size-3.5", pending === index && "animate-spin")}
                />
                Unstage hunk
              </button>
            )}
          </div>
          <Diff patch={hunk.patch} path={path} />
        </section>
      ))}
    </div>
  );
}
