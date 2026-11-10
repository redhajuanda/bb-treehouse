import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { BranchList } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { errorMessage, type Rpc } from "./data";

const MAX_SHOWN = 200;

export function BranchPicker({
  rpc,
  environmentId,
  repo,
  value,
  onChange,
}: {
  rpc: Rpc;
  environmentId: string;
  repo: string;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<BranchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    let cancelled = false;
    rpc.call("branches", { environmentId, repo }).then(
      (next) => {
        if (!cancelled) setList(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, rpc, environmentId, repo]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = (list?.branches ?? []).filter((b) => b.name !== list?.current);
    const hits = needle === "" ? all : all.filter((b) => b.name.toLowerCase().includes(needle));
    hits.sort(
      (a, b) =>
        Number(b.name === list?.defaultBase) - Number(a.name === list?.defaultBase) ||
        Number(a.remote) - Number(b.remote),
    );
    return hits.slice(0, MAX_SHOWN);
  }, [list, query]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = filtered[active];
      if (picked !== undefined) choose(picked.name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-0" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value === null ? "Pick a branch to compare with" : `Compare with ${value}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-6 max-w-[200px] items-center gap-1 rounded-full pl-2 pr-1.5 text-xs hover:bg-state-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          value === null
            ? "border border-dashed border-border text-muted-foreground hover:text-foreground"
            : "bg-secondary font-mono text-secondary-foreground",
        )}
      >
        {value === null ? null : <Icon name="GitBranch" className="size-3 shrink-0 text-muted-foreground" />}
        <span className="truncate">{value ?? "Pick a branch"}</span>
        <Icon name="ChevronDown" className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5">
            <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search branches"
              aria-label="Search branches"
              className="h-9 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {error !== null ? (
              <p className="px-3 py-4 text-center text-sm text-destructive">{error}</p>
            ) : list === null ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">Loading branches…</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">No branches match.</p>
            ) : (
              filtered.map((branch, index) => (
                <div
                  key={`${branch.remote ? "r" : "l"}:${branch.name}`}
                  role="option"
                  aria-selected={branch.name === value}
                  data-index={index}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(branch.name)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === active && "bg-state-hover",
                  )}
                >
                  <Icon
                    name={branch.remote ? "Cloud" : "GitBranch"}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
                  {branch.name === list.defaultBase ? (
                    <span className="shrink-0 rounded bg-secondary px-1 text-xs text-muted-foreground">main</span>
                  ) : null}
                  <Icon
                    name="Check"
                    className={cn("size-3.5 shrink-0", branch.name === value ? "opacity-100" : "opacity-0")}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
