import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export const ROW_HEIGHT = 26;
const OVERSCAN = 12;

export function VirtualList<T>({
  items,
  getKey,
  renderRow,
  className,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let frame = 0;
    const update = () => {
      frame = 0;
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
  }, []);

  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const visible = items.slice(first, last);

  return (
    <div ref={ref} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${className ?? ""}`}>
      <div style={{ height: items.length * ROW_HEIGHT, position: "relative" }}>
        <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {visible.map((item) => (
            <div key={getKey(item)} style={{ height: ROW_HEIGHT }}>
              {renderRow(item)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
