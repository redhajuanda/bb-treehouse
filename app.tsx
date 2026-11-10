import { useMemo, useState } from "react";
import { definePluginApp, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { GitView } from "./ui/GitView";
import { NamesView } from "./ui/NamesView";
import { indexBadges, useRefreshSignal, useStatus, useTreehouseRpc } from "./ui/data";

type Mode = "names" | "git";

const modes = new Map<string, Mode>();
const queries = new Map<string, string>();

function TreehouseTab({ environment }: ExperimentalThreadTabProps) {
  if (environment === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">This thread has no workspace.</p>;
  }
  return <Treehouse key={environment.id} environmentId={environment.id} />;
}

function Treehouse({ environmentId }: { environmentId: string }) {
  const rpc = useTreehouseRpc();
  const [mode, setModeState] = useState<Mode>(() => modes.get(environmentId) ?? "names");
  const [query, setQueryState] = useState(() => queries.get(environmentId) ?? "");
  const [manual, setManual] = useState(0);
  const [collapse, setCollapse] = useState(0);
  const auto = useRefreshSignal(environmentId);
  const signal = auto + manual;
  const { status, error, reload } = useStatus(rpc, environmentId, signal);
  const badges = useMemo(() => indexBadges(status), [status]);
  const changeCount = status !== null && status.repo ? status.files.length : 0;

  const setMode = (next: Mode) => {
    modes.set(environmentId, next);
    setModeState(next);
  };
  const setQuery = (next: string) => {
    queries.set(environmentId, next);
    setQueryState(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-2">
        <div role="tablist" className="flex flex-1 rounded-lg bg-secondary p-0.5">
          {(["names", "git"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-sm",
                mode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "names" ? "Names" : "Git"}
              {value === "git" && changeCount > 0 ? (
                <span className="text-xs text-muted-foreground">{changeCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        {mode === "names" ? (
          <button
            type="button"
            title="Collapse all"
            onClick={() => setCollapse((n) => n + 1)}
            className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ListCollapse" className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          title="Refresh"
          onClick={() => {
            setManual((n) => n + 1);
            reload();
          }}
          className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="RefreshCw" className="size-4" />
        </button>
      </div>
      {mode === "names" ? (
        <>
          <div className="px-2 py-2">
            <div className="flex items-center gap-2 rounded-md border border-input px-2">
              <Icon name="ListFilter" className="size-4 shrink-0 text-muted-foreground" />
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
                <button type="button" title="Clear" onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
                  <Icon name="X" className="size-3.5" />
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
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-border">
          <GitView rpc={rpc} environmentId={environmentId} status={status} statusError={error} reload={reload} />
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "treehouse",
    title: "Files",
    tooltip: "Treehouse: files and git",
    icon: "FolderTree",
    layout: "flush",
    component: TreehouseTab,
  });
});
