import { describe, expect, it } from "vitest";
import type { Commit } from "../contract";
import { layoutGraph, parseRefs } from "../ui/graph";

const commit = (sha: string, parents: string[], refs = ""): Commit => ({
  sha,
  parents,
  author: "a",
  email: "",
  time: 0,
  refs,
  subject: sha,
});

describe("layoutGraph", () => {
  it("draws a branch that splits from a merge and joins its base", () => {
    const { rows, width } = layoutGraph([
      commit("merge", ["m1", "f2"]),
      commit("f2", ["f1"]),
      commit("m1", ["base"]),
      commit("f1", ["base"]),
      commit("base", []),
    ]);
    expect(width).toBe(2);
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 1, 0]);
    expect(rows[0]?.top).toEqual([]);
    expect(rows[0]?.bottom.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(rows[4]?.top.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(rows[4]?.bottom).toEqual([]);
  });

  it("starts a new lane for each branch tip", () => {
    const { rows } = layoutGraph([commit("a", ["base"]), commit("b", ["base"]), commit("base", [])]);
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0]);
    expect(rows[1]?.top.map((s) => [s.from, s.to])).toEqual([[0, 0]]);
  });
});

describe("parseRefs", () => {
  it("keeps the checked-out branch and tags and hides remotes that mirror a local branch", () => {
    expect(parseRefs("HEAD -> main, origin/main, origin/HEAD, tag: v1.0, origin/feature")).toEqual([
      { kind: "head", name: "main" },
      { kind: "tag", name: "v1.0" },
      { kind: "remote", name: "origin/feature" },
    ]);
  });
});
