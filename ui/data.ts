import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_useRpcKeyedQuery, experimental_useTabVisible, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL, WATCH_RENEW_MS, type Change, type WorkspaceStatus, type rpcContract } from "../contract";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export function useTreehouseRpc(): Rpc {
  return useRpc<typeof rpcContract>();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const gitStatusContract = defineRpcContract({
  status: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.unknown()),
  },
});

const changedPayload = z.object({ environmentId: z.string() });
const POLL_MS = 5000;

export function useCachedState<T>(
  cache: Map<string, T>,
  key: string,
  fallback: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const read = useCallback(() => (cache.has(key) ? (cache.get(key) as T) : fallbackRef.current()), [cache, key]);
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: read() }));
  const value = state.key === key ? state.value : read();
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setState((prev) => {
        const base = prev.key === key ? prev.value : read();
        const next = typeof action === "function" ? (action as (value: T) => T)(base) : action;
        cache.set(key, next);
        return { key, value: next };
      });
    },
    [cache, key, read],
  );
  return [value, set];
}

const workspaceCache = new Map<string, WorkspaceStatus | null>();

export function useWatchLease(rpc: Rpc, environmentId: string): boolean | null {
  const [watching, setWatching] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const renew = () => {
      rpc.call("watch", { environmentId }).then(
        (result) => {
          if (!cancelled) setWatching(result.watching);
        },
        () => {
          if (!cancelled) setWatching(false);
        },
      );
    };
    renew();
    const timer = setInterval(renew, WATCH_RENEW_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpc, environmentId]);
  return watching;
}

export function useRefreshSignal(environmentId: string, options: { poll?: boolean } = {}): number {
  const poll = options.poll ?? true;
  const visible = experimental_useTabVisible();
  const [tick, setTick] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stale = useRef(false);
  const bump = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      setTick((n) => n + 1);
    }, 150);
  }, []);
  const request = useCallback(() => {
    if (visible) bump();
    else stale.current = true;
  }, [visible, bump]);

  useEffect(() => {
    if (visible && stale.current) {
      stale.current = false;
      bump();
    }
  }, [visible, bump]);
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  useRealtime(CHANGED_CHANNEL, (payload) => {
    const parsed = changedPayload.safeParse(payload);
    if (parsed.success && parsed.data.environmentId === environmentId) request();
  });

  const fingerprint = experimental_useRpcKeyedQuery({
    pluginId: "bb--git",
    contract: gitStatusContract,
    method: "status",
    keys: [environmentId],
    select: (data) => JSON.stringify(data[environmentId] ?? null),
  }).data;
  const lastFingerprint = useRef(fingerprint);
  useEffect(() => {
    if (lastFingerprint.current === fingerprint) return;
    lastFingerprint.current = fingerprint;
    request();
  }, [fingerprint, request]);

  useEffect(() => {
    const onFocus = () => request();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [request]);

  useEffect(() => {
    if (!visible || !poll) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) bump();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, poll, bump]);

  return tick;
}

export function useWorkspaceStatus(rpc: Rpc, environmentId: string, signal: number) {
  const [workspace, setWorkspace] = useCachedState(workspaceCache, environmentId, () => null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const rescan = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const force = rescan.current;
    rescan.current = false;
    rpc.call("workspaceStatus", { environmentId, rescan: force }).then(
      (next) => {
        if (cancelled) return;
        setWorkspace((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, environmentId, signal, manual]);
  const reload = useCallback((options?: { rescan: boolean }) => {
    if (options?.rescan === true) rescan.current = true;
    setManual((n) => n + 1);
  }, []);
  return { workspace, error, reload };
}

export type Badge = "M" | "U" | "A" | "D" | "R" | "C";

export function badgeOf(change: Change): Badge {
  if (change.x === "?" || change.y === "?") return "U";
  if (change.x === "U" || change.y === "U") return "C";
  if (change.x === "D" || change.y === "D") return "D";
  if (change.x === "A") return "A";
  if (change.x === "R" || change.y === "R") return "R";
  return "M";
}

const BADGE_RANK: Record<Badge, number> = { C: 5, D: 4, M: 3, R: 3, A: 2, U: 1 };

export function badgeClass(badge: Badge): string {
  switch (badge) {
    case "U":
    case "A":
      return "text-diff-added";
    case "D":
    case "C":
      return "text-diff-removed";
    case "M":
    case "R":
      return "text-warning";
  }
}

export interface BadgeIndex {
  files: Map<string, Badge>;
  dirs: Map<string, Badge>;
}

export function indexBadges(workspace: WorkspaceStatus | null): BadgeIndex {
  const files = new Map<string, Badge>();
  const dirs = new Map<string, Badge>();
  if (workspace === null) return { files, dirs };
  for (const { repo, status } of workspace.repos) {
    if (!status.repo) continue;
    const prefix = repo === "" ? "" : `${repo}/`;
    for (const change of status.files) {
      const badge = badgeOf(change);
      const full = `${prefix}${change.path.replace(/\/+$/u, "")}`;
      files.set(full, badge);
      let slash = full.lastIndexOf("/");
      while (slash > 0) {
        const dir = full.slice(0, slash);
        const prev = dirs.get(dir);
        if (prev !== undefined && BADGE_RANK[prev] >= BADGE_RANK[badge]) break;
        dirs.set(dir, badge);
        slash = dir.lastIndexOf("/");
      }
    }
  }
  return { files, dirs };
}

export const PROJECT_PREFIX = "proj_";

export function isProjectScope(id: string): boolean {
  return id.startsWith(PROJECT_PREFIX);
}

const locations = new Map<string, { hostId: string; root: string }>();

export function useLocation(rpc: Rpc, id: string): void {
  useEffect(() => {
    if (!isProjectScope(id) || locations.has(id)) return;
    rpc.call("locate", { environmentId: id }).then(
      (location) => locations.set(id, location),
      () => undefined,
    );
  }, [rpc, id]);
}

export function fileTarget(
  id: string,
  path: string,
): { kind: "workspace"; environmentId: string; path: string } | { kind: "host"; hostId: string; path: string } | null {
  if (!isProjectScope(id)) return { kind: "workspace", environmentId: id, path };
  const location = locations.get(id);
  if (location === undefined) return null;
  return { kind: "host", hostId: location.hostId, path: `${location.root.replace(/\/+$/u, "")}/${path}` };
}
