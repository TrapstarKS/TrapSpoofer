import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '../../lib/utils';

/**
 * Minimal fixed-row-height virtual list: only the visible slice (+ overscan)
 * is rendered, so thousands of rows stay smooth.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  getKey,
  className,
  overscan = 8,
  empty,
  ariaLabel,
}: {
  items: T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
  className?: string;
  overscan?: number;
  empty?: ReactNode;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight || 480);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight || 480));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the scroll position valid when the list shrinks (filters/search).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = Math.max(0, items.length * rowHeight - el.clientHeight);
    if (el.scrollTop > max) {
      el.scrollTop = max;
      setScrollTop(max);
    }
  }, [items.length, rowHeight]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      role="list"
      aria-label={ariaLabel}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={cn('relative overflow-y-auto', className)}
    >
      {items.length === 0 ? (
        empty
      ) : (
        <div style={{ height: items.length * rowHeight, position: 'relative' }}>
          {slice.map((item, i) => {
            const index = start + i;
            return (
              <div
                key={getKey(item, index)}
                role="listitem"
                style={{
                  position: 'absolute',
                  top: index * rowHeight,
                  left: 0,
                  right: 0,
                  height: rowHeight,
                }}
              >
                {renderRow(item, index)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
