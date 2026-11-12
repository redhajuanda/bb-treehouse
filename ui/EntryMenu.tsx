import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import {
  experimental_copyToClipboard,
  experimental_saveFile,
  experimental_useCanOpenFileExternally,
  useBbContext,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { entryName } from "../contract";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { errorMessage, fileTarget, type Rpc } from "./data";

/** What a right-click landed on. `path` is workspace-relative; "" is the workspace root. */
export interface EntryTarget {
  path: string;
  dir: boolean;
}

export interface EntryActionsOptions {
  rpc: Rpc;
  environmentId: string;
  rootPath: string | null;
  /** Shows a file in the Files tab's own preview, below the tree. */
  openFile: (path: string) => void;
  /** Called after an entry was created, renamed or duplicated so the tree can reload and reveal it. */
  onChanged: (info: { parent: string; path: string | null; removed?: string }) => void;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const ALT = IS_MAC ? "⌥" : "Alt+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";
const SHORTCUTS = {
  copyPath: `${MOD}${ALT}C`,
  copyRelative: `${MOD}${ALT}${SHIFT}C`,
  rename: IS_MAC ? "↩" : "F2",
  delete: IS_MAC ? "⌘⌫" : "Delete",
};

function parentOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function joinAbs(root: string, rel: string): string {
  const trimmed = root.replace(/[\\/]+$/u, "");
  return rel === "" ? trimmed : `${trimmed}/${rel}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Prompt =
  | { kind: "create"; parent: string; dir: boolean }
  | { kind: "rename"; target: EntryTarget }
  | { kind: "delete"; target: EntryTarget };

/**
 * Every file action the tree offers: the context menu, row shortcuts and the
 * dialogs they open share this one state so a shortcut and a menu item behave
 * the same way.
 */
export function useEntryActions({ rpc, environmentId, rootPath, openFile, onChanged }: EntryActionsOptions) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const { threadId } = useBbContext();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((text: string, error = false) => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 8000 : 2500);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string, label: string) => {
      const ok = await experimental_copyToClipboard({ text });
      say(ok ? `Copied ${label}` : "Could not copy to the clipboard", !ok);
    },
    [say],
  );

  const copyPath = useCallback(
    (target: EntryTarget) => {
      if (rootPath === null) return say("The workspace path is not loaded yet", true);
      void copy(joinAbs(rootPath, target.path), "path");
    },
    [copy, rootPath, say],
  );
  const copyRelativePath = useCallback(
    (target: EntryTarget) => void copy(target.path === "" ? "." : target.path, "relative path"),
    [copy],
  );

  const view = useCallback((target: EntryTarget) => openFile(target.path), [openFile]);

  const openInTab = useCallback(
    (target: EntryTarget) => {
      const live = fileTarget(environmentId, target.path);
      if (live === null) return;
      navigate.experimental_openFilePreview({ target: live, location: null });
    },
    [environmentId, navigate],
  );

  const openExternally = useCallback(
    (target: EntryTarget) => {
      const live = fileTarget(environmentId, target.path);
      if (
        live === null ||
        !navigate.experimental_openFileExternally({
          target: live,
          location: null,
        })
      ) {
        say("No external editor is set up for this machine", true);
      }
    },
    [environmentId, navigate, say],
  );

  const openTerminal = useCallback(
    async (target: EntryTarget) => {
      const dirRel = target.dir ? target.path : parentOf(target.path);
      try {
        let terminalId: string;
        if (threadId !== null) {
          const cwd = rootPath === null ? null : joinAbs(rootPath, dirRel);
          const session = await sdk.terminals.create({
            cols: 120,
            rows: 32,
            title: dirRel === "" ? "Terminal" : baseName(dirRel),
            scope: { kind: "thread", threadId },
            ...(cwd === null || dirRel === ""
              ? {}
              : {
                  start: {
                    mode: "argv" as const,
                    argv: ["sh", "-c", `cd ${shellQuote(cwd)} && exec "\${SHELL:-sh}" -l`],
                  },
                }),
          });
          terminalId = session.id;
        } else {
          const { hostId, root } = await rpc.call("locate", { environmentId });
          const session = await sdk.terminals.create({
            cols: 120,
            rows: 32,
            title: dirRel === "" ? "Terminal" : baseName(dirRel),
            scope: { kind: "host_path", hostId, cwd: joinAbs(root, dirRel) },
          });
          terminalId = session.id;
        }
        if (!(await navigate.experimental_openTerminal({ terminalId }))) {
          say("This view has no terminal panel", true);
        }
      } catch (cause) {
        say(errorMessage(cause), true);
      }
    },
    [environmentId, navigate, rootPath, rpc, sdk, say, threadId],
  );

  const download = useCallback(
    async (target: EntryTarget) => {
      say(target.dir ? `Archiving ${baseName(target.path)}…` : `Downloading ${baseName(target.path)}…`);
      try {
        const file = await rpc.call("readEntry", {
          environmentId,
          path: target.path,
        });
        const blob = new Blob([decodeBase64(file.base64)], { type: file.mime });
        const outcome = await experimental_saveFile({
          fileName: file.fileName,
          blob,
        });
        if (outcome === "started") say(`Saved ${file.fileName}`);
      } catch (cause) {
        say(errorMessage(cause), true);
      }
    },
    [environmentId, rpc, say],
  );

  const duplicate = useCallback(
    async (target: EntryTarget) => {
      try {
        const result = await rpc.call("duplicateEntry", {
          environmentId,
          path: target.path,
        });
        onChanged({ parent: parentOf(target.path), path: result.path });
        say(`Created ${baseName(result.path)}`);
      } catch (cause) {
        say(errorMessage(cause), true);
      }
    },
    [environmentId, onChanged, rpc, say],
  );

  const reveal = useCallback(
    async (target: EntryTarget) => {
      try {
        const result = await rpc.call("revealEntry", {
          environmentId,
          path: target.path,
        });
        if (!result.opened) say("No file manager found on the workspace machine", true);
      } catch (cause) {
        say(errorMessage(cause), true);
      }
    },
    [environmentId, rpc, say],
  );

  const create = useCallback((target: EntryTarget, dir: boolean) => {
    setPrompt({
      kind: "create",
      parent: target.dir ? target.path : parentOf(target.path),
      dir,
    });
  }, []);
  const rename = useCallback((target: EntryTarget) => {
    if (target.path !== "") setPrompt({ kind: "rename", target });
  }, []);
  const remove = useCallback((target: EntryTarget) => {
    if (target.path !== "") setPrompt({ kind: "delete", target });
  }, []);

  /** Row shortcuts; returns true when the key was handled. */
  const handleKey = useCallback(
    (event: KeyboardEvent, target: EntryTarget): boolean => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (mod && event.altKey && event.code === "KeyC") {
        if (event.shiftKey) copyRelativePath(target);
        else copyPath(target);
        return true;
      }
      if (target.path === "") return false;
      if (IS_MAC ? event.key === "Enter" && !mod : event.key === "F2") {
        rename(target);
        return true;
      }
      if (event.key === "Delete" || (mod && event.key === "Backspace")) {
        remove(target);
        return true;
      }
      return false;
    },
    [copyPath, copyRelativePath, remove, rename],
  );

  const submitName = useCallback(
    async (name: string) => {
      if (prompt === null || prompt.kind === "delete") return;
      if (prompt.kind === "create") {
        const result = await rpc.call("createEntry", {
          environmentId,
          parent: prompt.parent,
          name,
          dir: prompt.dir,
        });
        setPrompt(null);
        onChanged({ parent: prompt.parent, path: result.path });
        if (!prompt.dir) view({ path: result.path, dir: false });
        return;
      }
      const result = await rpc.call("renameEntry", {
        environmentId,
        path: prompt.target.path,
        name,
      });
      setPrompt(null);
      onChanged({
        parent: parentOf(prompt.target.path),
        path: result.path,
        removed: prompt.target.path,
      });
    },
    [environmentId, onChanged, prompt, rpc, view],
  );

  const confirmDelete = useCallback(async () => {
    if (prompt?.kind !== "delete") return;
    await rpc.call("deleteEntry", { environmentId, path: prompt.target.path });
    setPrompt(null);
    onChanged({
      parent: parentOf(prompt.target.path),
      path: null,
      removed: prompt.target.path,
    });
  }, [environmentId, onChanged, prompt, rpc]);

  const dialogs = (
    <>
      <NameDialog
        prompt={prompt?.kind === "delete" ? null : prompt}
        onCancel={() => setPrompt(null)}
        onSubmit={submitName}
      />
      <DeleteDialog
        target={prompt?.kind === "delete" ? prompt.target : null}
        onCancel={() => setPrompt(null)}
        onConfirm={confirmDelete}
      />
      {notice === null ? null : (
        <div
          role="status"
          className={cn(
            "pointer-events-none absolute inset-x-2 bottom-2 z-10 truncate rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-md",
            notice.error ? "text-destructive" : "text-muted-foreground",
          )}
          title={notice.text}
        >
          {notice.text}
        </div>
      )}
    </>
  );

  return {
    actions: {
      create,
      copyPath,
      copyRelativePath,
      duplicate,
      view,
      openInTab,
      openExternally,
      openTerminal,
      download,
      reveal,
      rename,
      remove,
    },
    handleKey,
    dialogs,
  };
}

export type EntryActions = ReturnType<typeof useEntryActions>["actions"];

/**
 * Wraps the tree. Rows mark themselves with `data-entry-path` and
 * `data-entry-dir`; a right-click on empty space targets `fallback`.
 */
export function EntryContextMenu({
  environmentId,
  actions,
  fallback,
  children,
}: {
  environmentId: string;
  actions: EntryActions;
  fallback: EntryTarget;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<EntryTarget>(fallback);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        asChild
        onContextMenu={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-entry-path]");
          setTarget(
            row === null
              ? fallback
              : {
                  path: row.dataset.entryPath ?? "",
                  dir: row.dataset.entryDir === "true",
                },
          );
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </Menu.Trigger>
      <EntryMenuContent environmentId={environmentId} actions={actions} target={target} />
    </Menu.Root>
  );
}

function EntryMenuContent({
  environmentId,
  actions,
  target,
}: {
  environmentId: string;
  actions: EntryActions;
  target: EntryTarget;
}) {
  const scopeProps = usePortalScopeProps();
  const live = fileTarget(environmentId, target.path);
  const canOpenExternally = experimental_useCanOpenFileExternally(
    live ?? { kind: "workspace", environmentId, path: target.path },
  );
  const isRoot = target.path === "";
  return (
    <Menu.Portal>
      <Menu.Content
        {...scopeProps}
        collisionPadding={8}
        className="z-50 min-w-60 overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Item icon="File" onSelect={() => actions.create(target, false)}>
          New File
        </Item>
        <Item icon="FolderPlus" onSelect={() => actions.create(target, true)}>
          New Folder
        </Item>
        <Separator />
        <Item icon="Link" shortcut={SHORTCUTS.copyPath} onSelect={() => actions.copyPath(target)}>
          Copy Path
        </Item>
        <Item icon="Link" shortcut={SHORTCUTS.copyRelative} onSelect={() => actions.copyRelativePath(target)}>
          Copy Relative Path
        </Item>
        <Item icon="Copy" disabled={isRoot} onSelect={() => void actions.duplicate(target)}>
          Duplicate
        </Item>
        {target.dir ? null : (
          <Item icon="FileText" onSelect={() => actions.view(target)}>
            View File
          </Item>
        )}
        <Item icon="Download" disabled={isRoot} onSelect={() => void actions.download(target)}>
          {target.dir ? "Download as .tar.gz" : "Download"}
        </Item>
        <Menu.Sub>
          <Menu.SubTrigger className={itemClass}>
            <Icon name="FolderOpen" className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">Open in</span>
            <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" />
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent
              {...scopeProps}
              sideOffset={4}
              collisionPadding={8}
              className="z-50 min-w-52 overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
            >
              {target.dir ? null : (
                <Item icon="Eye" onSelect={() => actions.openInTab(target)}>
                  Preview Tab
                </Item>
              )}
              <Item
                icon="ExternalLink"
                disabled={!canOpenExternally}
                hint={canOpenExternally ? undefined : "Not set up"}
                onSelect={() => actions.openExternally(target)}
              >
                External Editor
              </Item>
              <Item icon="Terminal" onSelect={() => void actions.openTerminal(target)}>
                Terminal
              </Item>
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
        <Item icon="FolderExport" onSelect={() => void actions.reveal(target)}>
          Reveal in File Manager
        </Item>
        <Separator />
        <Item icon="Edit" disabled={isRoot} shortcut={SHORTCUTS.rename} onSelect={() => actions.rename(target)}>
          Rename
        </Item>
        <Item
          icon="Trash2"
          destructive
          disabled={isRoot}
          shortcut={SHORTCUTS.delete}
          onSelect={() => actions.remove(target)}
        >
          Delete
        </Item>
      </Menu.Content>
    </Menu.Portal>
  );
}

const itemClass =
  "flex h-8 cursor-pointer select-none items-center gap-2.5 rounded-md px-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-state-hover data-[state=open]:bg-state-hover";

function Item({
  icon,
  fallback,
  shortcut,
  hint,
  destructive = false,
  disabled = false,
  onSelect,
  children,
}: {
  icon: string;
  fallback?: string;
  shortcut?: string;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item disabled={disabled} onSelect={onSelect} className={cn(itemClass, destructive && "text-destructive")}>
      <Icon
        name={icon}
        fallback={fallback ?? "File"}
        className={cn("size-4 shrink-0", destructive ? "text-destructive" : "text-muted-foreground")}
      />
      <span className="flex-1">{children}</span>
      {hint !== undefined || shortcut !== undefined ? (
        <span className="ml-6 shrink-0 text-xs text-muted-foreground">{hint ?? shortcut}</span>
      ) : null}
    </Menu.Item>
  );
}

function Separator() {
  return <Menu.Separator className="-mx-1 my-1 h-px bg-border" />;
}

function NameDialog({
  prompt,
  onCancel,
  onSubmit,
}: {
  prompt: Exclude<Prompt, { kind: "delete" }> | null;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = prompt !== null;
  const initial = prompt?.kind === "rename" ? baseName(prompt.target.path) : "";

  useEffect(() => {
    if (!open) return;
    setValue(initial);
    setError(null);
    setBusy(false);
  }, [open, initial]);

  const title =
    prompt === null
      ? ""
      : prompt.kind === "rename"
        ? `Rename ${prompt.target.dir ? "folder" : "file"}`
        : prompt.dir
          ? "New folder"
          : "New file";
  const where = prompt === null ? "" : prompt.kind === "rename" ? parentOf(prompt.target.path) : prompt.parent;

  const submit = async () => {
    const parsed = entryName.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid name");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(parsed.data);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (input === null) return;
          input.focus();
          const dot = prompt?.kind === "rename" && !prompt.target.dir ? input.value.lastIndexOf(".") : -1;
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            in {where === "" ? "workspace root" : `${where}/`}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="grid gap-2"
        >
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder={prompt?.kind === "create" && prompt.dir ? "folder-name" : "file-name.ext"}
            aria-label="Name"
            aria-invalid={error !== null}
          />
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || value.trim() === "" || value === initial}>
              {prompt?.kind === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: EntryTarget | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = target !== null;
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target === null ? "" : baseName(target.path)}?</DialogTitle>
          <DialogDescription>
            {target?.dir
              ? "The folder and everything inside it will be deleted from disk."
              : "The file will be deleted from disk."}{" "}
            This does not use the trash. Changes git has not committed cannot be recovered.
          </DialogDescription>
        </DialogHeader>
        {target === null ? null : <p className="break-all font-mono text-xs text-muted-foreground">{target.path}</p>}
        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            autoFocus
            onClick={() => {
              setBusy(true);
              onConfirm().catch((cause: unknown) => {
                setError(errorMessage(cause));
                setBusy(false);
              });
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
