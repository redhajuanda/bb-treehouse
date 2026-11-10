import { useEffect, useMemo, useState } from "react";
import { definePluginApp, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { DiffTab } from "./ui/DiffTab";
import { GitView } from "./ui/GitView";
import { GraphView } from "./ui/GraphView";
import { NamesView } from "./ui/NamesView";
import { indexBadges, useRefreshSignal, useTreehouseRpc, useWorkspaceStatus } from "./ui/data";

type Mode = "files" | "diff" | "graph";

const MODE_LABELS: Record<Mode, string> = { files: "Files", diff: "Diff", graph: "Graph" };

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

function TreehouseTab({ environment }: ExperimentalThreadTabProps) {
  if (environment === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">This thread has no workspace.</p>;
  }
  return <Treehouse key={environment.id} environmentId={environment.id} />;
}

function Treehouse({ environmentId }: { environmentId: string }) {
  const rpc = useTreehouseRpc();
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
  const auto = useRefreshSignal(environmentId);
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
  const setQuery = (next: string) => {
    queries.set(environmentId, next);
    setQueryState(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col [&_[role=button]]:cursor-pointer [&_[role=option]]:cursor-pointer [&_[role=tab]]:cursor-pointer [&_button:disabled]:cursor-not-allowed [&_button]:cursor-pointer [&_select]:cursor-pointer">
      <div className="flex items-center gap-1 px-2 pt-2">
        <div role="tablist" className="flex flex-1 rounded-lg bg-secondary p-0.5">
          {(["files", "diff", "graph"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-sm",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {MODE_LABELS[value]}
              {value === "diff" && changeCount > 0 ? (
                <span className="text-xs text-muted-foreground">{changeCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        {mode === "files" ? (
          <button
            type="button"
            title="Collapse all"
            onClick={() => setCollapse((n) => n + 1)}
            className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ChevronsUp" className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          title="Refresh"
          onClick={() => {
            setManual((n) => n + 1);
            reload({ rescan: true });
          }}
          className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="ArrowReloadHorizontal" className="size-4" />
        </button>
      </div>
      {mode === "files" ? (
        <>
          <div className="px-2 py-2">
            <div className="flex items-center gap-2 rounded-md border border-input px-2">
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
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-border">
            <NamesView
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
        <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-border">
          <GraphView rpc={rpc} environmentId={environmentId} workspace={workspace} signal={graphSignal} />
        </div>
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-border">
          <GitView
            rpc={rpc}
            environmentId={environmentId}
            workspace={workspace}
            workspaceError={error}
            reload={reload}
          />
        </div>
      )}
    </div>
  );
}

const TAB_REFERENCE = { id: "treehouse", context: { kind: "thread" }, availability: "fixed" } as const;

export default definePluginApp((app) => {
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
    tooltip: "Treehouse: files and git",
    icon: "Folder02",
    layout: "flush",
    component: TreehouseTab,
  });
});
