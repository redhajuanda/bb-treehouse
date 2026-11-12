import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { experimental_useCodeTheme, type PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { errorMessage, useRefreshSignal, useTreehouseRpc } from "./data";
import { setDirty } from "./editorStore";

function languageFor(name: string): LanguageSupport | Extension | null {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (lower === "dockerfile" || lower.startsWith("dockerfile.") || ext === "dockerfile") {
    return StreamLanguage.define(dockerFile);
  }
  if (lower === "makefile" || [".env", ".bashrc", ".zshrc", ".profile"].includes(lower)) {
    return StreamLanguage.define(shell);
  }
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
    case "json5":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return html();
    case "py":
      return python();
    case "yml":
    case "yaml":
      return yaml();
    case "go":
      return go();
    case "rs":
      return rust();
    case "sql":
      return sql();
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    case "ini":
    case "properties":
    case "env":
    case "conf":
      return StreamLanguage.define(properties);
    default:
      return null;
  }
}

/** TextMate scopes to try for each highlight tag, most specific first. */
const TAG_SCOPES: Array<[Tag[], string[]]> = [
  [[tags.comment, tags.lineComment, tags.blockComment, tags.docComment], ["comment"]],
  [[tags.string, tags.special(tags.string), tags.character], ["string"]],
  [
    [tags.regexp, tags.escape],
    ["string.regexp", "constant.character.escape", "string"],
  ],
  [
    [tags.number, tags.integer, tags.float],
    ["constant.numeric", "constant"],
  ],
  [
    [tags.bool, tags.null, tags.atom],
    ["constant.language", "constant"],
  ],
  [
    [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword],
    ["keyword.control", "keyword", "storage"],
  ],
  [
    [tags.modifier, tags.self],
    ["storage.modifier", "storage", "keyword"],
  ],
  [[tags.operator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator], ["keyword.operator"]],
  [
    [tags.function(tags.variableName), tags.function(tags.propertyName)],
    ["entity.name.function", "support.function"],
  ],
  [
    [tags.typeName, tags.className, tags.namespace],
    ["entity.name.type", "support.type", "entity.name.class", "storage.type"],
  ],
  [[tags.definition(tags.variableName)], ["variable", "variable.other"]],
  [[tags.propertyName], ["variable.other.property", "support.type.property-name", "variable"]],
  [[tags.tagName], ["entity.name.tag"]],
  [[tags.attributeName], ["entity.other.attribute-name"]],
  [[tags.heading], ["markup.heading", "entity.name.section"]],
  [
    [tags.link, tags.url],
    ["markup.underline.link", "string"],
  ],
  [
    [tags.meta, tags.processingInstruction],
    ["meta", "comment"],
  ],
  [[tags.invalid], ["invalid"]],
];

function scopeColors(theme: PluginCodeThemeData) {
  const rules: Array<{ selector: string; foreground?: string; fontStyle?: string }> = [];
  for (const rule of theme.tokenColors) {
    const scopes = rule.scope === undefined ? [] : typeof rule.scope === "string" ? rule.scope.split(",") : rule.scope;
    for (const scope of scopes) {
      const selector = scope.trim();
      if (selector === "" || selector.includes(" ")) continue;
      rules.push({ selector, foreground: rule.settings.foreground, fontStyle: rule.settings.fontStyle });
    }
  }
  return (scope: string) => {
    let best: (typeof rules)[number] | undefined;
    for (const rule of rules) {
      if (rule.foreground === undefined) continue;
      if (scope !== rule.selector && !scope.startsWith(`${rule.selector}.`)) continue;
      if (best === undefined || rule.selector.length >= best.selector.length) best = rule;
    }
    return best;
  };
}

/** Translates bb's active code theme (a VS Code theme) into CodeMirror's theme and highlighting. */
function themeExtension(theme: PluginCodeThemeData | null): Extension {
  const color = (key: string, fallback: string) => theme?.colors[key] ?? fallback;
  const dark = theme?.type === "dark";
  const base = EditorView.theme(
    {
      "&": {
        height: "100%",
        color: theme?.fg ?? "inherit",
        backgroundColor: color("editor.background", theme?.bg ?? "transparent"),
        fontSize: "12.5px",
      },
      ".cm-scroller": {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
        lineHeight: "1.55",
      },
      ".cm-content": { caretColor: color("editorCursor.foreground", "currentColor") },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: color("editorCursor.foreground", "currentColor") },
      "&.cm-focused": { outline: "none" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
        {
          backgroundColor: color("editor.selectionBackground", dark ? "#264f78" : "#add6ff"),
        },
      ".cm-activeLine": { backgroundColor: color("editor.lineHighlightBackground", "transparent") },
      ".cm-gutters": {
        backgroundColor: color("editorGutter.background", color("editor.background", "transparent")),
        color: color("editorLineNumber.foreground", dark ? "#6e7681" : "#8c959f"),
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: color("editorLineNumber.activeForeground", theme?.fg ?? "inherit"),
      },
      ".cm-searchMatch": { backgroundColor: color("editor.findMatchHighlightBackground", "#ffd33d44") },
      ".cm-panels": { backgroundColor: color("editorWidget.background", "inherit"), color: "inherit" },
      ".cm-tooltip": { backgroundColor: color("editorWidget.background", "inherit"), color: "inherit" },
    },
    { dark },
  );
  if (theme === null) return base;
  const find = scopeColors(theme);
  const specs = TAG_SCOPES.flatMap(([tagList, scopes]) => {
    const rule = scopes.map(find).find((r) => r !== undefined);
    if (rule === undefined) return [];
    const style = rule.fontStyle ?? "";
    return [
      {
        tag: tagList,
        color: rule.foreground,
        fontStyle: style.includes("italic") ? "italic" : undefined,
        fontWeight: style.includes("bold") ? "bold" : undefined,
      },
    ];
  });
  return [
    base,
    syntaxHighlighting(
      HighlightStyle.define([
        ...specs,
        { tag: tags.strong, fontWeight: "bold" },
        { tag: tags.emphasis, fontStyle: "italic" },
      ]),
    ),
  ];
}

type Banner = { kind: "conflict" } | { kind: "changed" } | { kind: "error"; text: string } | null;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);

/**
 * Edits one workspace file. Saves with Ctrl/⌘+S; a save is refused if the
 * file changed on disk since it was loaded, and the editor asks what to do.
 */
export function FileEditor({ environmentId, path, active }: { environmentId: string; path: string; active: boolean }) {
  const rpc = useTreehouseRpc();
  const { theme } = experimental_useCodeTheme();
  // The editor is built after the file loads, so it reads the newest theme from here.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const signal = useRefreshSignal(environmentId, { poll: false });
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saved = useRef<{ doc: Text; hash: string } | null>(null);
  /** The newest on-disk version already reported, so one outside change is announced once. */
  const seenDiskHash = useRef<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "binary" | "too-large" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const themeCompartment = useRef(new Compartment());
  const saveRef = useRef<() => void>(() => undefined);

  const markDirty = useCallback(
    (value: boolean) => {
      setDirtyState(value);
      setDirty(environmentId, path, value);
    },
    [environmentId, path],
  );

  const replaceDoc = useCallback((content: string) => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, []);

  // Load the file and build the editor once.
  useEffect(() => {
    let cancelled = false;
    rpc.call("readText", { environmentId, path }).then(
      (result) => {
        if (cancelled) return;
        if (result.kind !== "text") {
          setStatus(result.kind);
          return;
        }
        const host = hostRef.current;
        if (host === null) return;
        const language = languageFor(path.slice(path.lastIndexOf("/") + 1));
        const state = EditorState.create({
          doc: result.content,
          extensions: [
            basicSetup,
            keymap.of([
              indentWithTab,
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
            ]),
            language ?? [],
            themeCompartment.current.of(themeExtension(themeRef.current)),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || saved.current === null) return;
              markDirty(!update.state.doc.eq(saved.current.doc));
            }),
          ],
        });
        saved.current = { doc: state.doc, hash: result.hash };
        viewRef.current = new EditorView({ state, parent: host });
        setStatus("ready");
      },
      (cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause));
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      setDirty(environmentId, path, false);
    };
    // The editor is built once per file; theme changes go through the compartment below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, environmentId, path, markDirty]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(themeExtension(theme)) });
  }, [theme]);

  useEffect(() => {
    if (active && status === "ready") viewRef.current?.focus();
  }, [active, status]);

  // Follow changes made on disk (an agent, git, another editor).
  useEffect(() => {
    if (signal === 0 || status !== "ready") return;
    let cancelled = false;
    rpc.call("readText", { environmentId, path }).then(
      (result) => {
        const view = viewRef.current;
        if (cancelled || result.kind !== "text" || view === null || saved.current === null) return;
        if (result.hash === saved.current.hash || result.hash === seenDiskHash.current) return;
        if (view.state.doc.eq(saved.current.doc)) {
          replaceDoc(result.content);
          saved.current = { doc: view.state.doc, hash: result.hash };
          markDirty(false);
        } else {
          seenDiskHash.current = result.hash;
          // A refused save is the more useful message; keep it.
          setBanner((prev) => (prev?.kind === "conflict" ? prev : { kind: "changed" }));
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [signal, status, rpc, environmentId, path, replaceDoc, markDirty]);

  const save = useCallback(
    async (force: boolean) => {
      const view = viewRef.current;
      if (view === null || saved.current === null || saving) return;
      const doc = view.state.doc;
      setSaving(true);
      try {
        const result = await rpc.call("writeText", {
          environmentId,
          path,
          content: doc.toString(),
          expectedHash: force ? null : saved.current.hash,
        });
        if (result.kind === "conflict") {
          seenDiskHash.current = result.hash;
          setBanner({ kind: "conflict" });
          return;
        }
        saved.current = { doc, hash: result.hash };
        markDirty(!view.state.doc.eq(doc));
        setBanner(null);
      } catch (cause) {
        setBanner({ kind: "error", text: errorMessage(cause) });
      } finally {
        setSaving(false);
      }
    },
    [rpc, environmentId, path, saving, markDirty],
  );
  saveRef.current = () => void save(false);

  const reloadFromDisk = async () => {
    const result = await rpc.call("readText", { environmentId, path });
    const view = viewRef.current;
    if (result.kind !== "text" || view === null) return;
    replaceDoc(result.content);
    saved.current = { doc: view.state.doc, hash: result.hash };
    markDirty(false);
    setBanner(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={path}>
          {path}
        </span>
        <span>{saving ? "Saving…" : dirty ? "Unsaved changes" : status === "ready" ? "Saved" : ""}</span>
        <button
          type="button"
          title={`Save (${IS_MAC ? "⌘S" : "Ctrl+S"})`}
          disabled={!dirty || saving}
          onClick={() => void save(false)}
          className="flex h-6 items-center gap-1 rounded px-2 text-foreground hover:bg-state-hover disabled:opacity-40"
        >
          <Icon name="Check" className="size-3.5" />
          Save
        </button>
      </div>
      {banner === null ? null : (
        <div
          role="alert"
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs",
            banner.kind === "error" ? "text-destructive" : "bg-warning/10 text-foreground",
          )}
        >
          <span className="min-w-0 flex-1">
            {banner.kind === "conflict"
              ? "The file changed on disk since you opened it, so it was not saved."
              : banner.kind === "changed"
                ? "The file changed on disk while you have unsaved edits."
                : banner.text}
          </span>
          {banner.kind === "error" ? null : (
            <>
              <button
                type="button"
                title="Throw away your edits and load the file as it is on disk"
                onClick={() => void reloadFromDisk()}
                className="rounded px-2 py-0.5 hover:bg-state-hover"
              >
                Reload from disk
              </button>
              <button
                type="button"
                title={
                  banner.kind === "conflict" ? "Save your version over the one on disk" : "Keep editing your version"
                }
                onClick={() => (banner.kind === "conflict" ? void save(true) : setBanner(null))}
                className="rounded px-2 py-0.5 font-medium hover:bg-state-hover"
              >
                {banner.kind === "conflict" ? "Overwrite" : "Keep mine"}
              </button>
            </>
          )}
          <button
            type="button"
            title="Dismiss"
            onClick={() => setBanner(null)}
            className="flex size-5 items-center justify-center rounded hover:bg-state-hover"
          >
            <Icon name="X" className="size-3" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className={cn("absolute inset-0", status !== "ready" && "hidden")} />
        {status === "loading" ? <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p> : null}
        {status === "binary" ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">This is a binary file, so it can't be edited here.</p>
        ) : null}
        {status === "too-large" ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">This file is too large to edit here (over 4 MB).</p>
        ) : null}
        {status === "error" ? <p className="px-4 py-3 text-sm text-destructive">{loadError}</p> : null}
      </div>
    </div>
  );
}
