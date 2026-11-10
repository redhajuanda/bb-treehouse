import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_useRpcKeyedQuery,
  experimental_useTabVisible,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL, type Change, type Status, type rpcContract } from "../contract";

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

export function useRefreshSignal(environmentId: string): number {
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

  return tick;
}

export function useStatus(rpc: Rpc, environmentId: string, signal: number) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  useEffect(() => {
    let cancelled = false;
    rpc.call("status", { environmentId }).then(
      (next) => {
        if (cancelled) return;
        setStatus((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
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
  const reload = useCallback(() => setManual((n) => n + 1), []);
  return { status, error, reload };
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

export function indexBadges(status: Status | null): BadgeIndex {
  const files = new Map<string, Badge>();
  const dirs = new Map<string, Badge>();
  if (status === null || !status.repo) return { files, dirs };
  for (const change of status.files) {
    const badge = badgeOf(change);
    files.set(change.path, badge);
    let slash = change.path.lastIndexOf("/");
    while (slash > 0) {
      const dir = change.path.slice(0, slash);
      const prev = dirs.get(dir);
      if (prev !== undefined && BADGE_RANK[prev] >= BADGE_RANK[badge]) break;
      dirs.set(dir, badge);
      slash = dir.lastIndexOf("/");
    }
  }
  return { files, dirs };
}
