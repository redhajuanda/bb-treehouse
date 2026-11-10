import { useEffect, useState } from "react";
import { z } from "zod";
import {
  experimental_Diff as Diff,
  useBbNavigate,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { FileIcon } from "./FileIcon";
import { errorMessage, useRefreshSignal, useTreehouseRpc } from "./data";

export const DIFF_TAB_REFERENCE = { id: "diff", context: { kind: "thread" }, availability: "action" } as const;

export const diffParamsSchema = z.object({
  repo: z.string(),
  path: z.string().min(1),
  staged: z.boolean(),
  untracked: z.boolean(),
});
export type DiffParams = z.infer<typeof diffParamsSchema>;

export function diffTabTitle(params: DiffParams): string {
  const name = params.path.slice(params.path.lastIndexOf("/") + 1);
  return params.staged ? `${name} (staged)` : name;
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
  return <DiffView key={environment.id} environmentId={environment.id} params={parsed.data} />;
}

function DiffView({ environmentId, params }: { environmentId: string; params: DiffParams }) {
  const rpc = useTreehouseRpc();
  const navigate = useBbNavigate();
  const signal = useRefreshSignal(environmentId);
  const [result, setResult] = useState<{ patch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { repo, path, staged, untracked } = params;

  useEffect(() => {
    let cancelled = false;
    rpc.call("diff", { environmentId, repo, path, staged, untracked }).then(
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
  }, [rpc, environmentId, repo, path, staged, untracked, signal]);

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
          {untracked ? "untracked" : staged ? "staged" : "working tree"}
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
          <Diff patch={result.patch} path={path} />
        )}
      </div>
    </div>
  );
}
