import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ICONS,
  EXTENSION_ICONS,
  FILE_NAME_ICONS,
  FOLDER_ICONS,
  FOLDER_OPEN_ICONS,
  ICON_SVGS,
} from "./file-icons.generated";

const uris = new Map<string, string>();

function uriFor(id: string): string {
  let uri = uris.get(id);
  if (uri === undefined) {
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ICON_SVGS[id] ?? "")}`;
    uris.set(id, uri);
  }
  return uri;
}

function fileIconId(name: string): string {
  const lower = name.toLowerCase();
  const byName = FILE_NAME_ICONS[lower];
  if (byName !== undefined) return byName;
  let dot = lower.indexOf(".", 1);
  while (dot !== -1) {
    const byExt = EXTENSION_ICONS[lower.slice(dot + 1)];
    if (byExt !== undefined) return byExt;
    dot = lower.indexOf(".", dot + 1);
  }
  return DEFAULT_ICONS.file;
}

function folderIconId(name: string, open: boolean): string {
  const lower = name.toLowerCase();
  const id = open ? FOLDER_OPEN_ICONS[lower] : FOLDER_ICONS[lower];
  return id ?? (open ? DEFAULT_ICONS.folderOpen : DEFAULT_ICONS.folder);
}

export const FileIcon = memo(function FileIcon({
  name,
  dir = false,
  open = false,
  className,
}: {
  name: string;
  dir?: boolean;
  open?: boolean;
  className?: string;
}) {
  const id = dir ? folderIconId(name, open) : fileIconId(name);
  return (
    <img
      src={uriFor(id)}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      className={cn("size-4 shrink-0 select-none", className)}
    />
  );
});
