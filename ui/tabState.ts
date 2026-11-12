/**
 * Pure tab-strip operations behind `useTabs`. Pinned tabs always sit at the
 * front, in pin order; "close others/right/all" leave them open.
 */
export interface TabsState {
  tabs: string[];
  pinned: string[];
  active: string | null;
  sidebarWidth: number;
  /** The tabs column (left) or the list column (right) is hidden; never both. */
  leftHidden: boolean;
  rightHidden: boolean;
  /** Recently closed tabs, newest last; session only. */
  closed: string[];
}

export const MAX_TABS = 30;
const MAX_CLOSED = 20;

export function emptyTabs(sidebarWidth: number): TabsState {
  return { tabs: [], pinned: [], active: null, sidebarWidth, leftHidden: false, rightHidden: false, closed: [] };
}

function pinnedCount(state: TabsState): number {
  return state.tabs.filter((t) => state.pinned.includes(t)).length;
}

export function openTab(state: TabsState, id: string): TabsState {
  if (state.tabs.includes(id)) return state.active === id ? state : { ...state, active: id };
  const afterActive = state.active === null ? state.tabs.length : state.tabs.indexOf(state.active) + 1;
  const at = Math.max(afterActive, pinnedCount(state));
  let tabs = [...state.tabs.slice(0, at), id, ...state.tabs.slice(at)];
  if (tabs.length > MAX_TABS) {
    const drop = tabs.find((t) => t !== id && !state.pinned.includes(t));
    if (drop !== undefined) tabs = tabs.filter((t) => t !== drop);
  }
  return { ...state, tabs, active: id, closed: state.closed.filter((t) => t !== id) };
}

/** Closes the tabs `shouldClose` picks; `keepPinned` protects pinned tabs (Close Others/Right/All). */
export function closeTabs(
  state: TabsState,
  shouldClose: (id: string, index: number) => boolean,
  keepPinned: boolean,
): TabsState {
  const closing = state.tabs.filter((t, i) => shouldClose(t, i) && !(keepPinned && state.pinned.includes(t)));
  if (closing.length === 0) return state;
  const tabs = state.tabs.filter((t) => !closing.includes(t));
  let active = state.active;
  if (active === null || !tabs.includes(active)) {
    const index = active === null ? 0 : state.tabs.indexOf(active);
    const right = state.tabs.slice(index + 1).find((t) => tabs.includes(t));
    const left = [...state.tabs.slice(0, index)].reverse().find((t) => tabs.includes(t));
    active = right ?? left ?? null;
  }
  const closed = [...state.closed.filter((t) => !closing.includes(t)), ...closing].slice(-MAX_CLOSED);
  return { ...state, tabs, active, pinned: state.pinned.filter((t) => tabs.includes(t)), closed };
}

export function reopenTab(state: TabsState): TabsState {
  const last = state.closed[state.closed.length - 1];
  if (last === undefined) return state;
  return openTab({ ...state, closed: state.closed.slice(0, -1) }, last);
}

/** Moves the active tab selection `step` places, wrapping around. */
export function cycleTab(state: TabsState, step: number): TabsState {
  if (state.tabs.length < 2 || state.active === null) return state;
  const index = state.tabs.indexOf(state.active);
  const next = state.tabs[(index + step + state.tabs.length) % state.tabs.length];
  return next === undefined ? state : { ...state, active: next };
}

export function setPinned(state: TabsState, id: string, pinned: boolean): TabsState {
  if (!state.tabs.includes(id) || state.pinned.includes(id) === pinned) return state;
  const rest = state.tabs.filter((t) => t !== id);
  const count = rest.filter((t) => state.pinned.includes(t)).length;
  // Pinning appends to the pinned group; unpinning puts the tab first among the unpinned.
  const tabs = [...rest.slice(0, count), id, ...rest.slice(count)];
  return {
    ...state,
    tabs,
    pinned: pinned ? [...state.pinned, id] : state.pinned.filter((t) => t !== id),
  };
}

/** Moves `id` to sit at `index` of the strip, kept inside its own group (pinned or not). */
export function moveTab(state: TabsState, id: string, index: number): TabsState {
  const from = state.tabs.indexOf(id);
  if (from === -1) return state;
  const rest = state.tabs.filter((t) => t !== id);
  const count = rest.filter((t) => state.pinned.includes(t)).length;
  const isPinned = state.pinned.includes(id);
  const target = Math.min(Math.max(index, isPinned ? 0 : count), isPinned ? count : rest.length);
  if (target === from) return state;
  return { ...state, tabs: [...rest.slice(0, target), id, ...rest.slice(target)] };
}

/** File tabs follow a rename (`to`) or close on delete (`to === null`). */
export function moveFiles(state: TabsState, from: string, to: string | null): TabsState {
  const under = (p: string) => p === from || p.startsWith(`${from}/`);
  if (!state.tabs.some(under)) return state;
  if (to === null) return closeTabs(state, under, false);
  const rename = (t: string) => (under(t) ? `${to}${t.slice(from.length)}` : t);
  return {
    ...state,
    tabs: state.tabs.map(rename),
    pinned: state.pinned.map(rename),
    active: state.active === null ? null : rename(state.active),
    closed: state.closed.filter((t) => !under(t)),
  };
}
