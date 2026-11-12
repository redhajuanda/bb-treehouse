import { useSyncExternalStore } from "react";

/**
 * Which open files have unsaved edits, and whether a file tab shows the
 * preview or the editor. Shared so the tab strip can mark dirty tabs and ask
 * before closing them.
 */
export type FileMode = "preview" | "edit";

const dirty = new Set<string>();
const modes = new Map<string, FileMode>();
const listeners = new Set<() => void>();
let version = 0;

const DEFAULT_MODE_KEY = "treehouse:editor:default-mode";
let defaultMode: FileMode = (() => {
  try {
    return localStorage.getItem(DEFAULT_MODE_KEY) === "edit" ? "edit" : "preview";
  } catch {
    return "preview";
  }
})();

const keyOf = (environmentId: string, path: string) => `${environmentId}\u0000${path}`;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDirty(environmentId: string, path: string, value: boolean) {
  const key = keyOf(environmentId, path);
  if (dirty.has(key) === value) return;
  if (value) dirty.add(key);
  else dirty.delete(key);
  emit();
}

export function isDirty(environmentId: string, path: string): boolean {
  return dirty.has(keyOf(environmentId, path));
}

export function modeOf(environmentId: string, path: string): FileMode {
  return modes.get(keyOf(environmentId, path)) ?? defaultMode;
}

/** Sets a file's mode; the choice also becomes the default for files opened later. */
export function setMode(environmentId: string, path: string, mode: FileMode) {
  modes.set(keyOf(environmentId, path), mode);
  defaultMode = mode;
  try {
    localStorage.setItem(DEFAULT_MODE_KEY, mode);
  } catch {
    // Not persisted; still applies this session.
  }
  emit();
}

export function forget(environmentId: string, path: string) {
  const key = keyOf(environmentId, path);
  const wasDirty = dirty.delete(key);
  const hadMode = modes.delete(key);
  if (wasDirty || hadMode) emit();
}

/** Re-renders when any file's dirty flag or mode changes. */
export function useEditorStore(): number {
  return useSyncExternalStore(subscribe, () => version);
}
