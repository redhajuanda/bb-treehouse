import type { Commit } from "../contract";

export interface Segment {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  column: number;
  color: number;
  top: Segment[];
  bottom: Segment[];
  width: number;
}

export function layoutGraph(commits: readonly Commit[]): { rows: GraphRow[]; width: number } {
  const lanes: Array<string | null> = [];
  const colors: number[] = [];
  let nextColor = 0;
  let width = 1;
  const rows: GraphRow[] = [];

  const freeSlot = (avoid: number) => {
    for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === null && i !== avoid) return i;
    lanes.push(null);
    colors.push(0);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    let column = lanes.indexOf(commit.sha);
    const tip = column === -1;
    if (tip) {
      column = freeSlot(-1);
      lanes[column] = commit.sha;
      colors[column] = nextColor++;
    }
    const color = colors[column] ?? 0;

    const top: Segment[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      const sha = lanes[i];
      if (sha === null || sha === undefined) continue;
      if (sha === commit.sha) {
        if (!(tip && i === column)) top.push({ from: i, to: column, color: colors[i] ?? 0 });
        if (i !== column) lanes[i] = null;
      } else {
        top.push({ from: i, to: i, color: colors[i] ?? 0 });
      }
    }

    const [first, ...rest] = commit.parents;
    lanes[column] = first ?? null;
    const bottom: Segment[] = [];
    if (first !== undefined) bottom.push({ from: column, to: column, color });
    for (const parent of rest) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = freeSlot(column);
        lanes[target] = parent;
        colors[target] = nextColor++;
      }
      bottom.push({ from: column, to: target, color: colors[target] ?? 0 });
    }
    for (let i = 0; i < lanes.length; i += 1) {
      if (i === column || lanes[i] === null) continue;
      if (bottom.some((s) => s.to === i)) continue;
      bottom.push({ from: i, to: i, color: colors[i] ?? 0 });
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }
    const rowWidth = Math.max(
      column + 1,
      ...top.map((s) => Math.max(s.from, s.to) + 1),
      ...bottom.map((s) => Math.max(s.from, s.to) + 1),
    );
    width = Math.max(width, rowWidth);
    rows.push({ column, color, top, bottom, width: rowWidth });
  }
  return { rows, width };
}

export interface Ref {
  kind: "head" | "branch" | "remote" | "tag";
  name: string;
}

export function parseRefs(refs: string): Ref[] {
  if (refs.trim() === "") return [];
  const out: Ref[] = [];
  for (const raw of refs.split(", ")) {
    const part = raw.trim();
    if (part === "" || part === "HEAD" || part.endsWith("/HEAD")) continue;
    if (part.startsWith("HEAD -> ")) out.push({ kind: "head", name: part.slice(8) });
    else if (part.startsWith("tag: ")) out.push({ kind: "tag", name: part.slice(5) });
    else if (part.includes("/")) out.push({ kind: "remote", name: part });
    else out.push({ kind: "branch", name: part });
  }
  const local = new Set(out.filter((r) => r.kind === "head" || r.kind === "branch").map((r) => r.name));
  return out.filter((r) => !(r.kind === "remote" && local.has(r.name.slice(r.name.indexOf("/") + 1))));
}

export function relativeTime(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, now / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 2) return "yesterday";
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}
