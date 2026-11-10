import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const ROW_HEIGHT = 26;
const OVERSCAN_PX = 400;
const scrollPositions = new Map<string, number>();

function lastAtOrBefore(offsets: readonly number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function VirtualList<T>({
  items,
  getKey,
  getHeight,
  renderRow,
  className,
  scrollKey,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  getHeight?: (item: T) => number;
  renderRow: (item: T) => ReactNode;
  className?: string;
  scrollKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (scrollKey !== undefined) {
      const saved = scrollPositions.get(scrollKey);
      if (saved !== undefined) el.scrollTop = saved;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      if (scrollKey !== undefined) scrollPositions.set(scrollKey, el.scrollTop);
      setViewport((prev) =>
        prev.top === el.scrollTop && prev.height === el.clientHeight
          ? prev
          : { top: el.scrollTop, height: el.clientHeight },
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollKey]);

  const heightOf = (item: T) => (getHeight === undefined ? ROW_HEIGHT : getHeight(item));
  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i += 1) {
      out[i + 1] = (out[i] ?? 0) + (getHeight === undefined ? ROW_HEIGHT : getHeight(items[i] as T));
    }
    return out;
  }, [items, getHeight]);

  const total = offsets[items.length] ?? 0;
  const first = Math.min(items.length, lastAtOrBefore(offsets, Math.max(0, viewport.top - OVERSCAN_PX)));
  const last = Math.min(items.length, lastAtOrBefore(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1);
  const visible = items.slice(first, last);

  return (
    <div ref={ref} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${className ?? ""}`}>
      <div style={{ height: total, position: "relative" }}>
        <div style={{ transform: `translateY(${offsets[first] ?? 0}px)` }}>
          {visible.map((item) => (
            <div key={getKey(item)} style={{ height: heightOf(item) }}>
              {renderRow(item)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
