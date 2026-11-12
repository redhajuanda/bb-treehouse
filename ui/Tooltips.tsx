import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "@/lib/portal-scope";

const SHOW_DELAY_MS = 450;
/** After a tooltip hides, the next one within this window shows at once, as in bb and most editors. */
const SKIP_DELAY_MS = 400;
const GAP = 6;
const MARGIN = 8;

export const TOOLTIP_ROOT_ATTRIBUTE = "data-treehouse-tooltips";

// Several Treehouse surfaces can be mounted at once (the Files tab and a bb
// diff tab); only the first one mounted runs the tooltip, so a hover never
// shows two.
const claims: symbol[] = [];
const claimListeners = new Set<() => void>();

function useIsOwner(): boolean {
  const [id] = useState(() => Symbol("tooltips"));
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    claims.push(id);
    const sync = () => setOwner(claims[0] === id);
    claimListeners.add(sync);
    for (const listener of claimListeners) listener();
    return () => {
      claims.splice(claims.indexOf(id), 1);
      claimListeners.delete(sync);
      for (const listener of claimListeners) listener();
    };
  }, [id]);
  return owner;
}

/**
 * One styled tooltip for everything under an element marked with
 * {@link TOOLTIP_ROOT_ATTRIBUTE}: any element with a `title` shows it on
 * hover or keyboard focus. The native title is moved to `data-tip` while
 * hovered so the browser does not show a second, slower tooltip; icon-only
 * buttons keep it as their accessible name through `aria-label`.
 */
export function Tooltips() {
  return useIsOwner() ? <TooltipLayer /> : null;
}

function TooltipLayer() {
  const scopeProps = usePortalScopeProps();
  const [tip, setTip] = useState<{ text: string; anchor: DOMRect } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    let lastHidden = 0;

    const textOf = (el: HTMLElement): string | null => {
      const title = el.getAttribute("title");
      if (title !== null) {
        el.removeAttribute("title");
        if (title !== "") {
          el.dataset.tip = title;
          if (!el.hasAttribute("aria-label") && el.textContent?.trim() === "") el.setAttribute("aria-label", title);
        }
      }
      const text = el.dataset.tip ?? "";
      return text.trim() === "" ? null : text;
    };

    const find = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const el = target.closest<HTMLElement>("[title], [data-tip]");
      if (el === null || el.closest(`[${TOOLTIP_ROOT_ATTRIBUTE}]`) === null) return null;
      return el;
    };

    const hide = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (current !== null) lastHidden = Date.now();
      current = null;
      setTip(null);
    };

    const show = (el: HTMLElement, immediate: boolean) => {
      const text = textOf(el);
      if (text === null) return hide();
      if (timer !== null) clearTimeout(timer);
      current = el;
      const reveal = () => {
        timer = null;
        if (current !== el || !el.isConnected) return;
        setTip({ text, anchor: el.getBoundingClientRect() });
      };
      if (immediate || Date.now() - lastHidden < SKIP_DELAY_MS) reveal();
      else timer = setTimeout(reveal, SHOW_DELAY_MS);
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const el = find(event.target);
      if (el === current) return;
      if (el === null) return hide();
      show(el, false);
    };
    const onOut = (event: PointerEvent) => {
      if (current === null) return;
      const next = event.relatedTarget;
      if (next instanceof Node && current.contains(next)) return;
      if (find(next) === null) hide();
    };
    const onFocus = (event: FocusEvent) => {
      const el = find(event.target);
      if (el === null || !(event.target instanceof Element) || !event.target.matches(":focus-visible")) return;
      show(el, false);
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (tip === null || el === null) {
      setPosition(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const { anchor } = tip;
    const below = anchor.bottom + GAP;
    const top = below + height + MARGIN > window.innerHeight ? anchor.top - GAP - height : below;
    const centered = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(MARGIN, centered), window.innerWidth - width - MARGIN);
    setPosition({ left, top: Math.max(MARGIN, top) });
  }, [tip]);

  if (tip === null) return null;
  return createPortal(
    <div
      {...scopeProps}
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[1000] max-w-80 break-words rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
      style={position === null ? { left: 0, top: 0, visibility: "hidden" } : { left: position.left, top: position.top }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
