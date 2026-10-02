import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchPopup } from '../lib/cache';
import { haptic, isPhone, scrollBehavior } from '../lib/motion';
import { PopupMap } from '../components/maps';
import { Icon } from '../components/Icon';
import { Cover } from '../components/PopupBits';
import { fmtDay, isLive } from '../lib/format';
import { useSheet } from '../lib/hooks';
import type { Popup } from '../lib/api';
import { Filters, usePopups, VerifiedSwitch } from './Explore';

export default function MapPage() {
  const q = usePopups();
  const items = q.data?.items ?? [];
  const { open } = useSheet();
  const qc = useQueryClient();
  const [hl, setHl] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // On phones a pin tap brings its card into view; on desktop it opens the pop-up.
  const onPin = (p: Popup) => {
    if (!isPhone()) return open(p.slug);
    haptic(6);
    setHl(p.id);
    const el = list.current, card = el?.querySelector<HTMLElement>(`[data-id="${p.id}"]`);
    if (!el || !card) return;
    const r = card.getBoundingClientRect(), box = el.getBoundingClientRect();
    el.scrollBy({ left: r.left + r.width / 2 - (box.left + box.width / 2), behavior: scrollBehavior() });
  };

  // And the other way round: when the card row stops on a card, its pin lights up and centres.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let t = 0;
    const settle = () => {
      if (!isPhone()) return;
      const box = el.getBoundingClientRect(), mid = box.left + box.width / 2;
      let best: HTMLElement | null = null, gap = Infinity;
      for (const c of el.querySelectorAll<HTMLElement>('[data-id]')) {
        const r = c.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid);
        if (d < gap) { gap = d; best = c; }
      }
      if (best?.dataset.id) setHl(best.dataset.id);
    };
    const onScroll = () => { clearTimeout(t); t = window.setTimeout(settle, 120); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(t); };
  }, []);

  return (
    <>
      <div className="eyebrow">London · {fmtDay(Date.now())}</div>
      <h1>Pop-up map</h1>
      <p className="intro d-only">Solid pins are verified. Dashed pins are still being checked, so tap one and help confirm it if you pass by.</p>
      <Filters />
      <div className="mapwrap">
        <div className="mapbox">
          <PopupMap items={items} highlight={hl} onPin={onPin} me={null} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} onAway={() => {}} />
          <div className="legend">
            <span className="tag t-ink"><Icon name="i-shield" />Verified</span>
            <span className="tag t-eng"><Icon name="i-checkc" />Community</span>
            <span className="tag t-watch">Being checked</span>
          </div>
        </div>
        <div className="maplist noscroll" ref={list}>
          <div className="row d-only" style={{ justifyContent: 'space-between' }}><b className="small">{items.length} pop-ups</b><VerifiedSwitch /></div>
          {items.length ? items.map(p => (
            <Link key={p.id} data-id={p.id} to={`/p/${p.slug}`} className={`mini ${hl === p.id ? 'hl' : ''}`}
              onMouseEnter={() => setHl(p.id)} onPointerDown={() => prefetchPopup(qc, p.slug)} onClick={e => { e.preventDefault(); open(p.slug, e.currentTarget.querySelector('.sw')); }}>
              <Cover p={p} className="sw" />
              <span style={{ minWidth: 0 }}><b>{p.title}</b><span>{p.location.borough ?? 'London'} · {fmtDay(p.start_at)}{isLive(p) ? ' · on now' : ''}</span></span>
            </Link>
          )) : q.isPending ? Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="mini skc" aria-hidden="true"><div className="sw sk" /><span style={{ flex: 1 }} className="sk-block"><span className="sk skl" style={{ width: '80%' }} /><span className="sk skl" style={{ width: '50%' }} /></span></div>
          )) : <div className="empty" style={{ flex: 1 }}><p>No pop-ups match these filters.</p></div>}
        </div>
      </div>
      <p className="small muted m-only" style={{ display: 'block', marginTop: 6 }}>Tap a pin to find its card. Tap the card for details.</p>
    </>
  );
}
