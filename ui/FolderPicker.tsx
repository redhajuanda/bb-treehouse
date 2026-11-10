import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface FolderOption {
  key: string;
  title: string;
  path: string;
  repos: string[];
  changes: number;
  all: boolean;
}

function matches(option: FolderOption, needle: string): string | null {
  if (needle === "") return null;
  if (option.title.toLowerCase().includes(needle) || option.path.toLowerCase().includes(needle)) return null;
  const repo = option.repos.find((r) => r.toLowerCase().includes(needle));
  return repo ?? "";
}

export function FolderPicker({
  options,
  value,
  onChange,
}: {
  options: readonly FolderOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.key === value) ?? options[0];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options.flatMap((option) => {
      const hit = matches(option, needle);
      if (hit === "") return [];
      return [{ option, via: hit }];
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const index = options.findIndex((o) => o.key === value);
    setActive(index === -1 ? 0 : index);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, options, value]);

  useEffect(() => {
    setActive((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (key: string) => {
    onChange(key);
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
      if (picked !== undefined) choose(picked.option.key);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  if (current === undefined) return null;

  return (
    <div ref={rootRef} className="relative px-2 py-2">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-lg border border-transparent bg-secondary px-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          open && "border-border bg-state-hover",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <Icon name={current.all ? "Layers" : "FolderGit"} className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{current.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {current.repos.length} repo{current.repos.length === 1 ? "" : "s"}
            {current.path !== "" && current.path !== current.title ? ` · ${current.path}` : ""}
          </span>
        </span>
        <ChangeBadge count={current.changes} />
        <Icon
          name="ChevronDown"
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="absolute inset-x-2 top-full z-50 -mt-1 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5">
            <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search folders and repositories"
              aria-label="Search folders and repositories"
              className="h-9 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
            />
            {query === "" ? null : (
              <button
                type="button"
                title="Clear"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <Icon name="CircleX" className="size-3.5" />
              </button>
            )}
          </div>
          <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No folders match “{query}”.</p>
            ) : (
              filtered.map(({ option, via }, index) => {
                const selected = option.key === value;
                return (
                  <div
                    key={option.key}
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onPointerMove={() => setActive(index)}
                    onClick={() => choose(option.key)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
                      index === active && "bg-state-hover",
                      option.all && index === 0 && filtered.length > 1 && "mb-1",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-md",
                        selected ? "bg-foreground text-background" : "bg-secondary text-muted-foreground",
                      )}
                    >
                      <Icon name={option.all ? "Layers" : "FolderGit"} className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm font-medium">{option.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {via !== null && via !== ""
                          ? `contains ${via}`
                          : `${option.repos.length} repo${option.repos.length === 1 ? "" : "s"}${
                              option.path !== "" && option.path !== option.title ? ` · ${option.path}` : ""
                            }`}
                      </span>
                    </span>
                    <ChangeBadge count={option.changes} />
                    <Icon name="Check" className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                  </div>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChangeBadge({ count }: { count: number }) {
  if (count === 0) {
    return <span className="shrink-0 text-xs text-muted-foreground">clean</span>;
  }
  return (
    <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
      {count} changed
    </span>
  );
}
