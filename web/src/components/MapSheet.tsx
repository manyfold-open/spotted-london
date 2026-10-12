import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { nextSheetSize, pickSnap, type SheetSize, type Snap } from '../lib/map-home';

/**
 * The list that sits on the map. On a phone it is a bottom sheet with three stops (peek, half, full) that you
 * drag by its header; on a desktop it is a floating panel on the left, and `snap` only says whether it is wide.
 */
export function MapSheet({ phone, snap, onSnap, onVisible, header, children, collapsed }: {
  phone: boolean; snap: Snap; onSnap: (s: Snap) => void; onVisible: (px: number) => void; header: ReactNode; children: ReactNode;
  /** Desktop only: the panel is tucked away to the left and the map has the whole screen. */
  collapsed?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<SheetSize>({ h: 600, peek: 400, half: 200 });
  // The size before this one, for a short while: a measurement that goes back to it is a flip-flop (see nextSheetSize).
  const sizeNow = useRef(size); sizeNow.current = size;
  const sizeBefore = useRef<SheetSize | null>(null);
  const forget = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [dragY, setDragY] = useState<number | null>(null);
  const drag = useRef<{ y: number; base: number; t: number; dy: number } | null>(null);
  const offs: Record<Snap, number> = { full: 0, half: size.half, peek: size.peek };

  // Work out the three stops from the real sizes, so the peek stop shows exactly the header and one row of
  // cards, however tall those cards turn out. Runs after every render because cards arrive later.
  const measure = () => {
    const el = box.current, hd = head.current;
    if (!phone || !el || !hd) return;
    const h = el.offsetHeight, below = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    // One row of cards, or the whole message when there is nothing to show.
    const card = el.querySelector<HTMLElement>('.mp-minis .mini, .mp-sbody > .empty');
    const peekVisible = hd.offsetHeight + 4 + (card?.offsetHeight ?? 78) + 10 + 20 + below;
    const halfVisible = Math.round(window.innerHeight * 0.5);
    const next = { h, peek: Math.max(0, h - Math.min(peekVisible, halfVisible)), half: Math.max(0, h - halfVisible) };
    const keep = nextSheetSize(sizeNow.current, sizeBefore.current, next);
    if (keep === sizeNow.current) return;
    sizeBefore.current = sizeNow.current;
    clearTimeout(forget.current);
    forget.current = setTimeout(() => { sizeBefore.current = null; }, 2000);
    setSize(keep);
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const el = box.current, hd = head.current;
    if (!phone || !el || !hd) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(hd);
    return () => ro.disconnect();
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the page how much of the sheet shows, so the buttons and the map's padding can sit above it.
  useLayoutEffect(() => { if (phone && dragY === null) onVisible(size.h - offs[snap]); }, [phone, snap, size, dragY]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!phone) {
    return (
      <section className={`mp-panel ${collapsed ? 'collapsed' : ''}`} data-snap={snap} aria-label="Pop-ups" inert={collapsed}>
        <div className="mp-shead" ref={head}>{header}</div>
        <div className="mp-sbody">{children}</div>
      </section>
    );
  }

  const down = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    drag.current = { y: e.clientY, base: offs[snap], t: performance.now(), dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragY(offs[snap]);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dy = e.clientY - d.y;
    setDragY(Math.max(0, Math.min(size.peek, d.base + d.dy)));
  };
  const up = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const velocity = d.dy / Math.max(1, performance.now() - d.t);
    const y = Math.max(0, Math.min(size.peek, d.base + d.dy));
    setDragY(null);
    onSnap(pickSnap(y, velocity, offs));
  };

  return (
    <section ref={box} className={`mp-sheet ${dragY !== null ? 'drag' : ''}`} data-snap={snap} aria-label="Pop-ups"
      style={{ transform: `translateY(${dragY ?? offs[snap]}px)` }}>
      <div className="mp-shead" ref={head} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="mp-grab" aria-hidden="true" />
        {header}
      </div>
      {/* The part of the sheet below the screen edge is padding, so the last card can scroll into view. */}
      <div className="mp-sbody" style={{ paddingBottom: offs[snap] + 24 }}>{children}</div>
    </section>
  );
}
