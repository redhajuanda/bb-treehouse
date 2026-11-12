import { describe, expect, it } from "vitest";
import {
  closeTabs,
  cycleTab,
  emptyTabs,
  moveFiles,
  moveTab,
  openTab,
  reopenTab,
  setPinned,
  type TabsState,
} from "../ui/tabState";

function withTabs(...ids: string[]): TabsState {
  return ids.reduce((state, id) => openTab(state, id), emptyTabs(300));
}

describe("tab strip", () => {
  it("opens after the active tab and focuses an already open one", () => {
    let state = withTabs("a", "b", "c");
    state = openTab({ ...state, active: "a" }, "d");
    expect(state.tabs).toEqual(["a", "d", "b", "c"]);
    expect(openTab(state, "c").active).toBe("c");
  });

  it("activates the right neighbour on close and reopens closed tabs in reverse order", () => {
    let state = withTabs("a", "b", "c");
    state = closeTabs({ ...state, active: "b" }, (t) => t === "b", false);
    expect(state.active).toBe("c");
    state = closeTabs(state, (t) => t === "c", false);
    expect(state.active).toBe("a");
    state = reopenTab(state);
    expect(state.tabs).toEqual(["a", "c"]);
    state = reopenTab(state);
    expect(state.tabs).toContain("b");
    expect(reopenTab(state)).toBe(state);
  });

  it("keeps pinned tabs first and open through Close Others and Close All", () => {
    let state = withTabs("a", "b", "c");
    state = setPinned(state, "c", true);
    expect(state.tabs).toEqual(["c", "a", "b"]);
    state = openTab({ ...state, active: "c" }, "d");
    expect(state.tabs).toEqual(["c", "d", "a", "b"]);
    state = closeTabs(state, (t) => t !== "a", true);
    expect(state.tabs).toEqual(["c", "a"]);
    state = closeTabs(state, () => true, true);
    expect(state.tabs).toEqual(["c"]);
    state = setPinned(state, "c", false);
    expect(state.pinned).toEqual([]);
  });

  it("reorders within the tab's own group", () => {
    let state = setPinned(withTabs("a", "b", "c", "d"), "a", true);
    expect(moveTab(state, "d", 1).tabs).toEqual(["a", "d", "b", "c"]);
    expect(moveTab(state, "d", 0).tabs).toEqual(["a", "d", "b", "c"]);
    state = setPinned(state, "b", true);
    expect(moveTab(state, "a", 3).tabs).toEqual(["b", "a", "c", "d"]);
  });

  it("cycles with wrap-around", () => {
    const state = { ...withTabs("a", "b", "c"), active: "c" };
    expect(cycleTab(state, 1).active).toBe("a");
    expect(cycleTab(state, -1).active).toBe("b");
  });

  it("follows renames and closes deleted files", () => {
    let state = withTabs("src/a.ts", "src/b.ts", "readme.md");
    state = moveFiles(state, "src", "lib");
    expect(state.tabs).toEqual(["lib/a.ts", "lib/b.ts", "readme.md"]);
    state = moveFiles(state, "lib/a.ts", null);
    expect(state.tabs).toEqual(["lib/b.ts", "readme.md"]);
  });
});
