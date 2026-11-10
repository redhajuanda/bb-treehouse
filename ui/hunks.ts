export interface Hunk {
  header: string;
  patch: string;
}

export function splitHunks(patch: string): Hunk[] {
  const lines = patch.replace(/\n$/u, "").split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  if (first === -1) return [];
  const fileHeader = lines.slice(0, first).join("\n");
  const hunks: Hunk[] = [];
  let start = first;
  for (let i = first + 1; i <= lines.length; i += 1) {
    if (i === lines.length || lines[i]?.startsWith("@@")) {
      const body = lines.slice(start, i).join("\n");
      hunks.push({ header: lines[start] ?? "", patch: `${fileHeader}\n${body}\n` });
      start = i;
    }
  }
  return hunks;
}
