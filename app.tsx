import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  type ExperimentalThreadTabProps,
  type PluginNewThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { DiffTab } from "./ui/DiffTab";
import { GitView } from "./ui/GitView";
import { GraphView } from "./ui/GraphView";
import { FolderPicker, type FolderOption } from "./ui/FolderPicker";
import { NamesView } from "./ui/NamesView";
import {
  indexBadges,
  useLocation,
  useRefreshSignal,
  useTreehouseRpc,
  useWatchLease,
  useWorkspaceStatus,
} from "./ui/data";

type Mode = "files" | "diff" | "graph";

const MODES: readonly Mode[] = ["files", "diff", "graph"];
const MODE_LABELS: Record<Mode, string> = { files: "Files", diff: "Diff", graph: "Graph" };
const MODE_ICONS: Record<Mode, string> = { files: "Folder", diff: "FileDiff", graph: "GitMerge" };

const modes = new Map<string, Mode>();
const modeListeners = new Set<(mode: Mode) => void>();

function requestMode(mode: Mode) {
  if (modeListeners.size === 0) {
    pendingMode = mode;
    return;
  }
  for (const listener of modeListeners) listener(mode);
}

let pendingMode: Mode | null = null;
const queries = new Map<string, string>();
const fileBases = new Map<string, string>();
const hiddenIgnored = new Map<string, boolean>();

function parentOf(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash === -1 ? "" : repo.slice(0, slash);
}

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function TreehouseTab({ environment }: ExperimentalThreadTabProps) {
  if (environment === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">This thread has no workspace.</p>;
  }
  return <Treehouse key={environment.id} environmentId={environment.id} />;
}

function NewThreadTreehouse({ projectId }: PluginNewThreadPanelProps) {
  if (projectId === null) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Pick a project to browse its files. Threads without a project start in their own empty scratch folder.
      </p>
    );
  }
  return <Treehouse key={projectId} environmentId={projectId} />;
}

function Treehouse({ environmentId }: { environmentId: string }) {
  const rpc = useTreehouseRpc();
  useLocation(rpc, environmentId);
  const [mode, setModeState] = useState<Mode>(() => {
    const initial = pendingMode ?? modes.get(environmentId) ?? "files";
    pendingMode = null;
    return initial;
  });
  useEffect(() => {
    const listener = (next: Mode) => {
      pendingMode = null;
      modes.set(environmentId, next);
      setModeState(next);
    };
    modeListeners.add(listener);
    return () => {
      modeListeners.delete(listener);
    };
  }, [environmentId]);
  const [query, setQueryState] = useState(() => queries.get(environmentId) ?? "");
  const [manual, setManual] = useState(0);
  const [collapse, setCollapse] = useState(0);
  const watching = useWatchLease(rpc, environmentId);
  const auto = useRefreshSignal(environmentId, { poll: watching === false });
  const graphAuto = useRefreshSignal(environmentId, { poll: false });
  const graphSignal = graphAuto + manual;
  const signal = auto + manual;
  const { workspace, error, reload } = useWorkspaceStatus(rpc, environmentId, signal);
  const badges = useMemo(() => indexBadges(workspace), [workspace]);
  const changeCount = useMemo(
    () => (workspace?.repos ?? []).reduce((sum, r) => sum + (r.status.repo ? r.status.files.length : 0), 0),
    [workspace],
  );

  const setMode = (next: Mode) => {
    modes.set(environmentId, next);
    setModeState(next);
  };
  const [baseChoice, setBaseChoice] = useState(() => fileBases.get(environmentId) ?? "");
  const [hideIgnored, setHideIgnoredState] = useState(() => hiddenIgnored.get(environmentId) ?? false);
  const setHideIgnored = (next: boolean) => {
    hiddenIgnored.set(environmentId, next);
    setHideIgnoredState(next);
  };
  const fileOptions = useMemo<FolderOption[]>(() => {
    const repos = (workspace?.repos ?? []).flatMap((r) => (r.status.repo ? [{ repo: r.repo, status: r.status }] : []));
    const byKey = new Map<string, FolderOption>();
    byKey.set("", {
      key: "",
      title: workspace?.name ?? "workspace",
      path: "workspace root",
      repos: [],
      changes: repos.reduce((sum, r) => sum + r.status.files.length, 0),
      all: false,
      icon: "Folder",
      subtitle: "Whole workspace",
    });
    for (const r of repos) {
      if (r.repo === "") continue;
      const parent = parentOf(r.repo);
      if (parent !== "") {
        const group = byKey.get(parent);
        if (group === undefined) {
          byKey.set(parent, {
            key: parent,
            title: baseName(parent),
            path: parent,
            repos: [r.repo],
            changes: r.status.files.length,
            all: false,
            icon: "Folder",
          });
        } else if (group.icon === "Folder" && group.subtitle === undefined) {
          group.repos.push(r.repo);
          group.changes += r.status.files.length;
        }
      }
      byKey.set(r.repo, {
        key: r.repo,
        title: baseName(r.repo),
        path: r.repo,
        repos: [r.repo, r.status.branch ?? ""],
        changes: r.status.files.length,
        all: false,
        icon: "FolderGit",
        subtitle: `${r.status.branch ?? "detached"} · ${r.repo}`,
      });
    }
    const [root, ...rest] = [...byKey.values()];
    rest.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    return root === undefined ? rest : [root, ...rest];
  }, [workspace]);
  const base = fileOptions.some((o) => o.key === baseChoice) ? baseChoice : "";
  const setBase = (next: string) => {
    fileBases.set(environmentId, next);
    setBaseChoice(next);
  };

  const setQuery = (next: string) => {
    queries.set(environmentId, next);
    setQueryState(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col [&_[role=button]]:cursor-pointer [&_[role=button]:focus]:outline-none [&_[role=button]:focus-visible]:ring-1 [&_[role=button]:focus-visible]:ring-inset [&_[role=button]:focus-visible]:ring-ring [&_[role=option]:focus]:outline-none [&_[role=option]]:cursor-pointer [&_[role=tab]]:cursor-pointer [&_button:disabled]:cursor-not-allowed [&_button]:cursor-pointer [&_select]:cursor-pointer">
      <div className="flex items-stretch border-b border-border pr-1">
        <div role="tablist" aria-label="Treehouse view" className="relative grid flex-1 grid-cols-3">
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-px left-0 h-0.5 w-1/3 rounded-full bg-foreground transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)] motion-reduce:transition-none"
            style={{ transform: `translateX(${MODES.indexOf(mode) * 100}%)` }}
          />
          {MODES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 text-sm transition-colors duration-200 focus:outline-none focus-visible:rounded-md focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                mode === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name={MODE_ICONS[value]} className="size-4 shrink-0" />
              {MODE_LABELS[value]}
              {value === "diff" && changeCount > 0 ? (
                <span
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs tabular-nums leading-none",
                    mode === value
                      ? "bg-[oklch(0.56_0.17_255/0.2)] text-[oklch(0.75_0.13_255)]"
                      : "bg-secondary text-muted-foreground",
                  )}
                >
                  {changeCount > 99 ? "99+" : changeCount}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          title="Refresh"
          onClick={() => {
            setManual((n) => n + 1);
            reload({ rescan: true });
          }}
          className="my-auto flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="ArrowReloadHorizontal" className="size-4" />
        </button>
      </div>
      {mode === "files" ? (
        <>
          {fileOptions.length > 1 ? (
            <FolderPicker
              options={fileOptions}
              value={base}
              onChange={setBase}
              placeholder="Search folders and repositories"
            />
          ) : null}
          <div className={cn("flex items-center gap-1 px-2 pb-2", fileOptions.length > 1 ? "pt-0" : "pt-2")}>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input px-2">
              <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder="Find files"
                aria-label="Find files"
                className="h-8 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
              />
              {query === "" ? null : (
                <button
                  type="button"
                  title="Clear"
                  onClick={() => setQuery("")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="CircleX" className="size-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              title={hideIgnored ? "Show ignored files" : "Hide ignored files"}
              aria-pressed={hideIgnored}
              onClick={() => setHideIgnored(!hideIgnored)}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-state-hover hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                hideIgnored ? "bg-state-active text-foreground" : "text-muted-foreground",
              )}
            >
              <Icon name={hideIgnored ? "EyeOff" : "Eye"} className="size-4" />
            </button>
            <button
              type="button"
              title="Collapse all folders"
              onClick={() => setCollapse((n) => n + 1)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="ChevronsUp" className="size-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-border">
            <NamesView
              key={base}
              base={base}
              hideIgnored={hideIgnored}
              rootPath={workspace?.root ?? null}
              rpc={rpc}
              environmentId={environmentId}
              badges={badges}
              signal={signal}
              query={query}
              collapseSignal={collapse}
            />
          </div>
        </>
      ) : mode === "graph" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <GraphView rpc={rpc} environmentId={environmentId} workspace={workspace} signal={graphSignal} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <GitView
            rpc={rpc}
            environmentId={environmentId}
            workspace={workspace}
            workspaceError={error}
            reload={reload}
            signal={signal}
          />
        </div>
      )}
    </div>
  );
}

const TAB_REFERENCE = { id: "treehouse", context: { kind: "thread" }, availability: "fixed" } as const;

export default definePluginApp((app) => {
  app.slots.experimental_newThreadPanelAction({
    id: "treehouse",
    title: "Treehouse",
    icon: "Folder02",
    layout: "flush",
    component: NewThreadTreehouse,
  });
  app.commands.register({
    id: "toggle-files",
    title: "Treehouse: toggle files",
    defaultShortcut: { key: "e", mod: true, shift: true },
    isAvailable: (context) => context.threadId !== null,
    run(context) {
      context.experimental_panel.toggleTab({ tab: TAB_REFERENCE });
    },
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "diff",
    title: "Treehouse diff",
    tooltip: "Treehouse: open the Diff view",
    icon: "FileDiff",
    layout: "flush",
    component: DiffTab,
    run: ({ experimental_panel }) => {
      requestMode("diff");
      experimental_panel.openTab({ tab: TAB_REFERENCE });
    },
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "treehouse",
    title: "Files",
    tooltip: "Treehouse: files, diff and graph",
    icon: "Folder02",
    layout: "flush",
    component: TreehouseTab,
  });
});
