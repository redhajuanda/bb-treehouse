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

const MAX_TABS = 30;
const MIN_SIDEBAR = 160;
const DEFAULT_SIDEBAR = 300;

/** Which view the tabs belong to; each keeps its own set. */
export type TabScope = "files" | "diff";

interface TabsState {
  tabs: string[];
  active: string | null;
  sidebarWidth: number;
  sidebarHidden: boolean;
}

const memory = new Map<string, TabsState>();
const storageKey = (environmentId: string, scope: TabScope) => `treehouse:tabs:${scope}:${environmentId}`;

function loadState(environmentId: string, scope: TabScope): TabsState {
  const key = storageKey(environmentId, scope);
  const cached = memory.get(key);
  if (cached !== undefined) return cached;
  const fallback: TabsState = { tabs: [], active: null, sidebarWidth: DEFAULT_SIDEBAR, sidebarHidden: false };
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter((t): t is string => typeof t === "string") : [];
    return {
      tabs: tabs.slice(0, MAX_TABS),
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
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage full or disabled: tabs still live for this session.
  }
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The tabs Treehouse keeps open for one workspace and view, remembered across
 * reloads. A tab is an opaque id: a file path in Files, encoded diff params in Diff.
 */
export function useTabs(environmentId: string, scope: TabScope) {
  const [state, setState] = useState<TabsState>(() => loadState(environmentId, scope));
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

  const open = useCallback(
    (id: string) =>
      update((prev) => {
        if (prev.tabs.includes(id)) return prev.active === id ? prev : { ...prev, active: id };
        const at = prev.active === null ? prev.tabs.length : prev.tabs.indexOf(prev.active) + 1;
        let tabs = [...prev.tabs.slice(0, at), id, ...prev.tabs.slice(at)];
        if (tabs.length > MAX_TABS) {
          const drop = tabs.find((t) => t !== id);
          tabs = tabs.filter((t) => t !== drop);
        }
        return { ...prev, tabs, active: id };
      }),
    [update],
  );

  const closeWhere = useCallback(
    (shouldClose: (id: string, index: number, tabs: string[]) => boolean) =>
      update((prev) => {
        const tabs = prev.tabs.filter((t, i) => !shouldClose(t, i, prev.tabs));
        if (tabs.length === prev.tabs.length) return prev;
        let active = prev.active;
        if (active === null || !tabs.includes(active)) {
          const index = active === null ? 0 : prev.tabs.indexOf(active);
          const right = prev.tabs.slice(index + 1).find((t) => tabs.includes(t));
          const left = [...prev.tabs.slice(0, index)].reverse().find((t) => tabs.includes(t));
          active = right ?? left ?? null;
        }
        return { ...prev, tabs, active };
      }),
    [update],
  );

  const close = useCallback((id: string) => closeWhere((t) => t === id), [closeWhere]);
  const closeOthers = useCallback((id: string) => closeWhere((t) => t !== id), [closeWhere]);
  const closeRight = useCallback((id: string) => closeWhere((_, i, tabs) => i > tabs.indexOf(id)), [closeWhere]);
  const closeAll = useCallback(() => closeWhere(() => true), [closeWhere]);

  /** For file tabs: follow a rename (`to`) or close on delete (`to === null`). */
  const moved = useCallback(
    (from: string, to: string | null) =>
      update((prev) => {
        if (!prev.tabs.some((t) => under(t, from))) return prev;
        if (to === null) {
          const tabs = prev.tabs.filter((t) => !under(t, from));
          const active = prev.active !== null && tabs.includes(prev.active) ? prev.active : (tabs[0] ?? null);
          return { ...prev, tabs, active };
        }
        const rename = (t: string) => (under(t, from) ? `${to}${t.slice(from.length)}` : t);
        return { ...prev, tabs: prev.tabs.map(rename), active: prev.active === null ? null : rename(prev.active) };
      }),
    [update],
  );

  const setSidebarWidth = useCallback(
    (sidebarWidth: number) =>
      update((prev) => ({ ...prev, sidebarWidth: Math.max(MIN_SIDEBAR, Math.round(sidebarWidth)) })),
    [update],
  );
  const toggleSidebar = useCallback(
    () => update((prev) => ({ ...prev, sidebarHidden: !prev.sidebarHidden })),
    [update],
  );

  return { ...state, open, close, closeOthers, closeRight, closeAll, moved, setSidebarWidth, toggleSidebar };
}

export type Tabs = ReturnType<typeof useTabs>;

/** How a tab id shows in the strip. `path` picks the icon and disambiguates equal labels. */
export interface TabInfo {
  label: string;
  path: string;
  badge?: string;
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
}: {
  tabs: Tabs;
  sidebar: ReactNode;
  sidebarName: string;
  describe: (id: string) => TabInfo;
  renderTab: (id: string) => ReactNode;
  onPopOut: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabStrip tabs={tabs} describe={describe} sidebarName={sidebarName} onPopOut={onPopOut} />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {tabs.tabs.map((id) => (
              <TabPanel key={id} active={id === tabs.active}>
                {renderTab(id)}
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

const iconButton =
  "flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function TabStrip({
  tabs,
  describe,
  sidebarName,
  onPopOut,
}: {
  tabs: Tabs;
  describe: (id: string) => TabInfo;
  sidebarName: string;
  onPopOut: (id: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const infos = useMemo(() => withHints(tabs.tabs, describe), [tabs.tabs, describe]);

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
        onWheel={(event) => {
          if (event.deltaY !== 0 && stripRef.current !== null) stripRef.current.scrollLeft += event.deltaY;
        }}
      >
        {tabs.tabs.map((id) => (
          <Tab
            key={id}
            id={id}
            info={infos.get(id) ?? { label: id, path: id, hint: "" }}
            active={id === tabs.active}
            tabs={tabs}
            onPopOut={onPopOut}
          />
        ))}
      </div>
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
  tabs,
  onPopOut,
}: {
  id: string;
  info: TabInfo & { hint: string };
  active: boolean;
  tabs: Tabs;
  onPopOut: (id: string) => void;
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
          title={info.badge === undefined ? info.path : `${info.path} · ${info.badge}`}
          data-tab-id={id}
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
          <FileIcon name={name} className="size-4 shrink-0" />
          <span className="truncate">{info.label}</span>
          {info.hint === "" ? null : <span className="truncate text-xs text-muted-foreground">{info.hint}</span>}
          {info.badge === undefined ? null : (
            <span className="shrink-0 rounded bg-secondary px-1 text-[10px] leading-4 text-muted-foreground">
              {info.badge}
            </span>
          )}
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
              "flex size-5 shrink-0 items-center justify-center rounded hover:bg-state-hover",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <Icon name="X" className="size-3" />
          </button>
        </div>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          {...scopeProps}
          collisionPadding={8}
          className="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          <TabMenuItem onSelect={() => tabs.close(id)}>Close</TabMenuItem>
          <TabMenuItem disabled={tabs.tabs.length < 2} onSelect={() => tabs.closeOthers(id)}>
            Close Others
          </TabMenuItem>
          <TabMenuItem disabled={index === tabs.tabs.length - 1} onSelect={() => tabs.closeRight(id)}>
            Close to the Right
          </TabMenuItem>
          <TabMenuItem onSelect={tabs.closeAll}>Close All</TabMenuItem>
          <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
          <TabMenuItem onSelect={() => onPopOut(id)}>Open in a bb Tab</TabMenuItem>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function TabMenuItem({
  disabled = false,
  onSelect,
  children,
}: {
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex h-8 cursor-pointer select-none items-center rounded-md px-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-state-hover"
    >
      {children}
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

/** A file tab's body: bb's own file preview. */
export function FileTabBody({ environmentId, path }: { environmentId: string; path: string }) {
  const target = fileTarget(environmentId, path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (target === null) return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  return <FilePreview target={target} renderPreview={(file) => renderBody(name, file)} />;
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
