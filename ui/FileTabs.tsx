import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import {
  Markdown,
  experimental_FilePreview as FilePreview,
  type ExperimentalFilePreviewFile,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { fileTarget } from "./data";
import { FileEditor } from "./Editor";
import { forget, modeOf, setMode, useEditorStore } from "./editorStore";
import {
  MAX_TABS,
  closeTabs,
  cycleTab,
  emptyTabs,
  moveFiles,
  moveTab,
  openTab,
  reopenTab,
  setPinned,
  type TabsState,
} from "./tabState";

const MIN_SIDEBAR = 160;
const DEFAULT_SIDEBAR = 300;

/** Which view the tabs belong to; each keeps its own set. */
export type TabScope = "files" | "diff" | "graph";

const memory = new Map<string, TabsState>();
const storageKey = (environmentId: string, scope: TabScope) => `treehouse:tabs:${scope}:${environmentId}`;

function loadState(environmentId: string, scope: TabScope): TabsState {
  const key = storageKey(environmentId, scope);
  const cached = memory.get(key);
  if (cached !== undefined) return cached;
  const fallback = emptyTabs(DEFAULT_SIDEBAR);
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
    const tabs = strings(parsed.tabs).slice(0, MAX_TABS);
    const pinned = strings(parsed.pinned).filter((t) => tabs.includes(t));
    return {
      ...fallback,
      tabs: [...pinned, ...tabs.filter((t) => !pinned.includes(t))],
      pinned,
      active: typeof parsed.active === "string" && tabs.includes(parsed.active) ? parsed.active : (tabs[0] ?? null),
      sidebarWidth:
        typeof parsed.sidebarWidth === "number" ? Math.max(MIN_SIDEBAR, parsed.sidebarWidth) : DEFAULT_SIDEBAR,
      sidebarHidden: parsed.sidebarHidden === true,
    };
  } catch {
    return fallback;
  }
}

function saveState(environmentId: string, scope: TabScope, state: TabsState) {
  const key = storageKey(environmentId, scope);
  memory.set(key, state);
  try {
    const { closed: _closed, ...persisted } = state;
    localStorage.setItem(key, JSON.stringify(persisted));
  } catch {
    // Storage full or disabled: tabs still live for this session.
  }
}

/**
 * The tabs Treehouse keeps open for one workspace and view, remembered across
 * reloads. A tab is an opaque id: a file path in Files, encoded params in Diff and Graph.
 */
export function useTabs(
  environmentId: string,
  scope: TabScope,
  /** Asked before tabs close; return false to keep them (for example, unsaved edits). */
  confirmClose?: (ids: string[]) => boolean,
) {
  const [state, setState] = useState<TabsState>(() => loadState(environmentId, scope));
  const stateRef = useRef(state);
  stateRef.current = state;
  const confirmRef = useRef(confirmClose);
  confirmRef.current = confirmClose;
  const update = useCallback(
    (change: (prev: TabsState) => TabsState) => {
      setState((prev) => {
        const next = change(prev);
        if (next !== prev) saveState(environmentId, scope, next);
        return next;
      });
    },
    [environmentId, scope],
  );

  const actions = useMemo(() => {
    const close = (pick: (id: string, index: number, state: TabsState) => boolean, keepPinned: boolean) => {
      const current = stateRef.current;
      const ids = current.tabs.filter((t, i) => pick(t, i, current) && !(keepPinned && current.pinned.includes(t)));
      if (ids.length === 0) return;
      if (confirmRef.current !== undefined && !confirmRef.current(ids)) return;
      update((prev) => closeTabs(prev, (t) => ids.includes(t), false));
    };
    return {
      open: (id: string) => update((prev) => openTab(prev, id)),
      close: (id: string) => close((t) => t === id, false),
      closeActive: () => close((t, _, current) => t === current.active, false),
      closeOthers: (id: string) => close((t) => t !== id, true),
      closeRight: (id: string) => close((_, i, current) => i > current.tabs.indexOf(id), true),
      closeAll: () => close(() => true, true),
      reopen: () => update(reopenTab),
      next: () => update((prev) => cycleTab(prev, 1)),
      previous: () => update((prev) => cycleTab(prev, -1)),
      pin: (id: string, pinned: boolean) => update((prev) => setPinned(prev, id, pinned)),
      move: (id: string, index: number) => update((prev) => moveTab(prev, id, index)),
      moved: (from: string, to: string | null) => update((prev) => moveFiles(prev, from, to)),
      setSidebarWidth: (sidebarWidth: number) =>
        update((prev) => ({ ...prev, sidebarWidth: Math.max(MIN_SIDEBAR, Math.round(sidebarWidth)) })),
      toggleSidebar: () => update((prev) => ({ ...prev, sidebarHidden: !prev.sidebarHidden })),
    };
  }, [update]);

  return { ...state, ...actions };
}

export type Tabs = ReturnType<typeof useTabs>;

export const TAB_DRAG_TYPE = "application/x-treehouse-tab";
/** Set by the file tree when a file is dragged, so the Files tab strip can open it. */
export const PATH_DRAG_TYPE = "application/x-treehouse-path";

// The tab strip on screen, for bb commands (next tab, close tab, …). Only one
// Treehouse view shows at a time; the most recently mounted one wins.
const mounted: Array<{ current: Tabs }> = [];
export function visibleTabs(): Tabs | null {
  return mounted[mounted.length - 1]?.current ?? null;
}

/** How a tab id shows in the strip. `path` picks the icon and disambiguates equal labels. */
export interface TabInfo {
  label: string;
  path: string;
  badge?: string;
  /** A bb icon name; file tabs leave it out and get the file type's icon. */
  icon?: string;
  /** Unsaved edits: the close button shows a dot until hovered. */
  dirty?: boolean;
}

/**
 * Treehouse's own tabs on the left and the view's sidebar (the file tree, or
 * the Diff view's change list) on the right, so the sidebar never gets covered.
 */
export function TabbedLayout({
  tabs,
  sidebar,
  sidebarName,
  describe,
  renderTab,
  onPopOut,
  onPathDrop,
  stripActions,
}: {
  tabs: Tabs;
  sidebar: ReactNode;
  sidebarName: string;
  describe: (id: string) => TabInfo;
  renderTab: (id: string, active: boolean) => ReactNode;
  onPopOut: (id: string) => void;
  /** Accepts files dragged from the tree onto the tab area. */
  onPathDrop?: (path: string) => void;
  /** Controls for the active tab, shown at the end of the tab bar. */
  stripActions?: (id: string) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    const entry = tabsRef;
    mounted.push(entry);
    return () => {
      mounted.splice(mounted.indexOf(entry), 1);
    };
  }, []);
  const [pathDrag, setPathDrag] = useState(false);
  const dropHandlers =
    onPathDrop === undefined
      ? {}
      : {
          onDragOver: (event: React.DragEvent) => {
            if (!event.dataTransfer.types.includes(PATH_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setPathDrag(true);
          },
          onDragLeave: (event: React.DragEvent) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
              setPathDrag(false);
            }
          },
          onDrop: (event: React.DragEvent) => {
            setPathDrag(false);
            const path = event.dataTransfer.getData(PATH_DRAG_TYPE);
            if (path === "") return;
            event.preventDefault();
            onPathDrop(path);
          },
        };
  const hasTabs = tabs.tabs.length > 0;
  const showSidebar = !hasTabs || !tabs.sidebarHidden;

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (container === null) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = container.getBoundingClientRect().right;
    const max = container.clientWidth - 240;
    const move = (e: PointerEvent) => tabs.setSidebarWidth(Math.min(max, right - e.clientX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      {hasTabs ? (
        <div
          {...dropHandlers}
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            pathDrag &&
              "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:bg-ring/10 after:ring-2 after:ring-inset after:ring-ring/60",
          )}
        >
          <TabStrip
            tabs={tabs}
            describe={describe}
            sidebarName={sidebarName}
            onPopOut={onPopOut}
            actions={stripActions !== undefined && tabs.active !== null ? stripActions(tabs.active) : null}
          />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {tabs.tabs.map((id) => (
              <TabPanel key={id} active={id === tabs.active}>
                {renderTab(id, id === tabs.active)}
              </TabPanel>
            ))}
          </div>
        </div>
      ) : null}
      {hasTabs && showSidebar ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${sidebarName}`}
          title={`Drag to resize the ${sidebarName}. Double-click to reset.`}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => tabs.setSidebarWidth(DEFAULT_SIDEBAR)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") tabs.setSidebarWidth(tabs.sidebarWidth + 24);
            else if (event.key === "ArrowRight") tabs.setSidebarWidth(tabs.sidebarWidth - 24);
            else return;
            event.preventDefault();
          }}
          className="group relative w-1 shrink-0 cursor-col-resize border-r border-border focus:outline-none focus-visible:bg-ring/40"
        >
          <span className="absolute inset-y-0 -right-px w-0.5 transition-colors group-hover:bg-ring/60" />
        </div>
      ) : null}
      {showSidebar ? (
        <div
          className="flex min-h-0 min-w-0 flex-col"
          style={hasTabs ? { flex: `0 0 ${tabs.sidebarWidth}px`, maxWidth: "60%" } : { flex: "1 1 auto" }}
        >
          {sidebar}
        </div>
      ) : null}
    </div>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);
/** Default bindings of the tab commands registered in app.tsx; users can rebind them in bb. */
export const TAB_SHORTCUTS = {
  next: { key: "ArrowRight", mod: true, alt: true },
  previous: { key: "ArrowLeft", mod: true, alt: true },
  close: { key: "w", alt: true },
  reopen: { key: "t", alt: true, shift: true },
} as const;
const TAB_SHORTCUT_HINTS = {
  next: IS_MAC ? "⌘⌥→" : "Ctrl+Alt+→",
  previous: IS_MAC ? "⌘⌥←" : "Ctrl+Alt+←",
  close: IS_MAC ? "⌥W" : "Alt+W",
  reopen: IS_MAC ? "⌥⇧T" : "Alt+Shift+T",
};

const iconButton =
  "flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function TabStrip({
  tabs,
  describe,
  sidebarName,
  onPopOut,
  actions,
}: {
  tabs: Tabs;
  describe: (id: string) => TabInfo;
  sidebarName: string;
  onPopOut: (id: string) => void;
  actions: ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const infos = useMemo(() => withHints(tabs.tabs, describe), [tabs.tabs, describe]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragging = useRef<string | null>(null);

  const onDragOverTab = (event: React.DragEvent<HTMLElement>, index: number) => {
    if (dragging.current === null || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    setDropAt(event.clientX < rect.left + rect.width / 2 ? index : index + 1);
  };
  const onDrop = (event: React.DragEvent) => {
    const id = dragging.current;
    const at = dropAt;
    dragging.current = null;
    setDropAt(null);
    if (id === null || at === null) return;
    event.preventDefault();
    const from = tabs.tabs.indexOf(id);
    tabs.move(id, from < at ? at - 1 : at);
  };

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || tabs.active === null) return;
    strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabs.active)}"]`)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [tabs.active]);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open tabs"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
            setDropAt(null);
        }}
        onWheel={(event) => {
          if (event.deltaY !== 0 && stripRef.current !== null) stripRef.current.scrollLeft += event.deltaY;
        }}
      >
        {tabs.tabs.map((id, index) => (
          <Tab
            key={id}
            id={id}
            info={infos.get(id) ?? { label: id, path: id, hint: "" }}
            active={id === tabs.active}
            pinned={tabs.pinned.includes(id)}
            tabs={tabs}
            onPopOut={onPopOut}
            dropBefore={dropAt === index}
            dropAfter={dropAt === index + 1 && index === tabs.tabs.length - 1}
            onDragStart={(event) => {
              dragging.current = id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(TAB_DRAG_TYPE, id);
            }}
            onDragEnd={() => {
              dragging.current = null;
              setDropAt(null);
            }}
            onDragOver={(event) => onDragOverTab(event, index)}
            onDrop={onDrop}
          />
        ))}
      </div>
      {actions}
      {tabs.active === null ? null : (
        <button
          type="button"
          title="Open in a bb tab"
          onClick={() => tabs.active !== null && onPopOut(tabs.active)}
          className={cn(iconButton, "my-auto")}
        >
          <Icon name="ExternalLink" className="size-3.5" />
        </button>
      )}
      <button type="button" title="Close all tabs" onClick={tabs.closeAll} className={cn(iconButton, "my-auto")}>
        <Icon name="X" className="size-3.5" />
      </button>
      <button
        type="button"
        title={tabs.sidebarHidden ? `Show ${sidebarName}` : `Hide ${sidebarName}`}
        aria-pressed={!tabs.sidebarHidden}
        onClick={tabs.toggleSidebar}
        className={cn(iconButton, "my-auto mr-1")}
      >
        <Icon name="PanelRight" fallback="PanelLeft" className="size-4" />
      </button>
    </div>
  );
}

/** Adds the parent folder to tabs whose labels would otherwise look the same. */
function withHints(ids: readonly string[], describe: (id: string) => TabInfo) {
  const described = ids.map((id) => [id, describe(id)] as const);
  const counts = new Map<string, number>();
  for (const [, info] of described) counts.set(info.label, (counts.get(info.label) ?? 0) + 1);
  return new Map(
    described.map(([id, info]) => {
      const parent = info.path.includes("/") ? info.path.slice(0, info.path.lastIndexOf("/")) : "";
      const hint = (counts.get(info.label) ?? 0) > 1 ? parent.slice(parent.lastIndexOf("/") + 1) || "./" : "";
      return [id, { ...info, hint }];
    }),
  );
}

function Tab({
  id,
  info,
  active,
  pinned,
  tabs,
  onPopOut,
  dropBefore,
  dropAfter,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  id: string;
  info: TabInfo & { hint: string };
  active: boolean;
  pinned: boolean;
  tabs: Tabs;
  onPopOut: (id: string) => void;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
}) {
  const scopeProps = usePortalScopeProps();
  const index = tabs.tabs.indexOf(id);
  const name = info.path.slice(info.path.lastIndexOf("/") + 1);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <div
          role="tab"
          aria-selected={active}
          aria-label={info.label}
          tabIndex={active ? 0 : -1}
          title={[info.path, info.badge, info.dirty === true ? "unsaved changes" : undefined]
            .filter(Boolean)
            .join(" · ")}
          data-tab-id={id}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={() => tabs.open(id)}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              tabs.close(id);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") tabs.open(id);
            else if (event.key === "Delete") tabs.close(id);
            else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              const next = tabs.tabs[index + (event.key === "ArrowRight" ? 1 : -1)];
              if (next !== undefined) {
                tabs.open(next);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next)}"]`)
                  ?.focus();
              }
            } else return;
            event.preventDefault();
          }}
          className={cn(
            "group relative flex max-w-60 shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border pl-2.5 pr-1 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            active
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
        >
          {active ? <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-foreground" /> : null}
          {dropBefore ? <span aria-hidden className="absolute inset-y-1 -left-px w-0.5 rounded bg-ring" /> : null}
          {dropAfter ? <span aria-hidden className="absolute inset-y-1 -right-px w-0.5 rounded bg-ring" /> : null}
          {info.icon === undefined ? (
            <FileIcon name={name} className="size-4 shrink-0" />
          ) : (
            <Icon name={info.icon} fallback="GitMerge" className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{info.label}</span>
          {info.hint === "" ? null : <span className="truncate text-xs text-muted-foreground">{info.hint}</span>}
          {info.badge === undefined ? null : (
            <span className="shrink-0 rounded bg-secondary px-1 text-[10px] leading-4 text-muted-foreground">
              {info.badge}
            </span>
          )}
          {pinned ? (
            <button
              type="button"
              tabIndex={-1}
              title="Pinned. Click to unpin."
              aria-label={`Unpin ${info.label}`}
              onClick={(event) => {
                event.stopPropagation();
                tabs.pin(id, false);
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
            >
              <Icon name="Pin" fallback="Target" className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              tabIndex={-1}
              title="Close"
              aria-label={`Close ${info.label}`}
              onClick={(event) => {
                event.stopPropagation();
                tabs.close(id);
              }}
              className={cn(
                "group/close flex size-5 shrink-0 items-center justify-center rounded hover:bg-state-hover",
                active || info.dirty === true ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              {info.dirty === true ? (
                <>
                  <span aria-hidden className="size-2 rounded-full bg-foreground/70 group-hover/close:hidden" />
                  <Icon name="X" className="hidden size-3 group-hover/close:block" />
                </>
              ) : (
                <Icon name="X" className="size-3" />
              )}
            </button>
          )}
        </div>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          {...scopeProps}
          collisionPadding={8}
          className="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          <TabMenuItem onSelect={() => tabs.pin(id, !pinned)}>{pinned ? "Unpin" : "Pin"}</TabMenuItem>
          <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
          <TabMenuItem shortcut={TAB_SHORTCUT_HINTS.close} onSelect={() => tabs.close(id)}>
            Close
          </TabMenuItem>
          <TabMenuItem disabled={tabs.tabs.length < 2} onSelect={() => tabs.closeOthers(id)}>
            Close Others
          </TabMenuItem>
          <TabMenuItem disabled={index === tabs.tabs.length - 1} onSelect={() => tabs.closeRight(id)}>
            Close to the Right
          </TabMenuItem>
          <TabMenuItem onSelect={tabs.closeAll}>Close All</TabMenuItem>
          <TabMenuItem disabled={tabs.closed.length === 0} shortcut={TAB_SHORTCUT_HINTS.reopen} onSelect={tabs.reopen}>
            Reopen Closed Tab
          </TabMenuItem>
          <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
          <TabMenuItem onSelect={() => onPopOut(id)}>Open in a bb Tab</TabMenuItem>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function TabMenuItem({
  disabled = false,
  shortcut,
  onSelect,
  children,
}: {
  disabled?: boolean;
  shortcut?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex h-8 cursor-pointer select-none items-center gap-6 rounded-md px-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-state-hover"
    >
      <span className="flex-1">{children}</span>
      {shortcut === undefined ? null : <span className="text-xs text-muted-foreground">{shortcut}</span>}
    </Menu.Item>
  );
}

function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  // Inactive tabs stay mounted and laid out, only invisible: bb's code viewer
  // measures its size once, so display:none would leave it blank on return.
  // Staying mounted also keeps each tab's scroll position.
  return (
    <div
      role="tabpanel"
      aria-hidden={!active}
      inert={!active}
      className={cn("absolute inset-0 flex flex-col", active ? "z-10" : "pointer-events-none invisible")}
    >
      {children}
    </div>
  );
}

/** A file tab's body: bb's preview, or Treehouse's editor (see {@link FileModeToggle}). */
export function FileTabBody({ environmentId, path, active }: { environmentId: string; path: string; active: boolean }) {
  useEditorStore();
  const mode = modeOf(environmentId, path);
  const [editorOpened, setEditorOpened] = useState(mode === "edit");
  useEffect(() => {
    if (mode === "edit") setEditorOpened(true);
  }, [mode]);
  useEffect(() => () => forget(environmentId, path), [environmentId, path]);
  const target = fileTarget(environmentId, path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  // Both stay mounted once used, so switching keeps the editor's undo history and scroll.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className={cn("absolute inset-0 flex flex-col", mode === "edit" && "pointer-events-none invisible")}>
        {target === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <FilePreview target={target} renderPreview={(file) => renderBody(name, file)} />
        )}
      </div>
      {editorOpened ? (
        <div className={cn("absolute inset-0 flex flex-col", mode !== "edit" && "pointer-events-none invisible")}>
          <FileEditor environmentId={environmentId} path={path} active={active && mode === "edit"} />
        </div>
      ) : null}
    </div>
  );
}

/** Preview / Edit switch for the active file tab, shown in the tab bar. */
export function FileModeToggle({ environmentId, path }: { environmentId: string; path: string }) {
  useEditorStore();
  const mode = modeOf(environmentId, path);
  return (
    <div
      role="radiogroup"
      aria-label="Show the file as"
      className="my-auto mr-1 flex rounded-md border border-border p-0.5 text-xs"
    >
      {(["preview", "edit"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          title={value === "preview" ? "Show bb's preview of the file" : "Edit the file (saves with Ctrl/⌘+S)"}
          onClick={() => setMode(environmentId, path, value)}
          className={cn(
            "rounded px-2 py-0.5",
            mode === value ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === "preview" ? "Preview" : "Edit"}
        </button>
      ))}
    </div>
  );
}

export function describeFile(path: string): TabInfo {
  return { label: path.slice(path.lastIndexOf("/") + 1), path };
}

function renderBody(name: string, file: ExperimentalFilePreviewFile): ReactNode {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") {
    return <iframe title={name} src={file.url} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />;
  }
  if (ext === "csv" || ext === "tsv") return <CsvTable content={file.content} separator={ext === "tsv" ? "\t" : ","} />;
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <Markdown content={file.content} />
    </div>
  );
}

const CSV_MAX_ROWS = 1000;

function parseCsv(content: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < content.length && rows.length < CSV_MAX_ROWS; i += 1) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"' && content[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function CsvTable({ content, separator }: { content: string; separator: string }) {
  const [head, ...body] = parseCsv(content, separator);
  if (head === undefined) return <p className="px-4 py-3 text-sm text-muted-foreground">This file is empty.</p>;
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-background">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="odd:bg-state-hover/40">
              {row.map((cell, c) => (
                <td key={c} className="whitespace-nowrap px-2 py-1 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
