import { useRef, useState } from 'react';
import { Link } from 'react-router';
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
  const [hl, setHl] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const phone = () => window.matchMedia('(max-width: 899px)').matches;

  // On phones a pin tap brings its card into view; on desktop it opens the pop-up.
  const onPin = (p: Popup) => {
    if (!phone()) return open(p.slug);
    setHl(p.id);
    const card = list.current?.querySelector<HTMLElement>(`[data-id="${p.id}"]`);
    if (card && list.current) list.current.scrollTo({ left: card.offsetLeft - 16, behavior: 'smooth' });
  };

  return (
    <>
      <div className="eyebrow">London · {fmtDay(Date.now())}</div>
      <h1>Pop-up map</h1>
      <p className="intro d-only">Solid pins are verified. Dashed pins are still being checked, so tap one and help confirm it if you pass by.</p>
      <Filters />
      <div className="mapwrap">
        <div className="mapbox">
          <PopupMap items={items} highlight={hl} onPin={onPin} />
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
              onMouseEnter={() => setHl(p.id)} onClick={e => { e.preventDefault(); open(p.slug); }}>
              <Cover p={p} className="sw" />
              <span style={{ minWidth: 0 }}><b>{p.title}</b><span>{p.location.borough ?? 'London'} · {fmtDay(p.start_at)}{isLive(p) ? ' · on now' : ''}</span></span>
            </Link>
          )) : q.isPending ? <div className="sk" style={{ height: 64, flex: 1 }} /> : <div className="empty" style={{ flex: 1 }}><p>No pop-ups match these filters.</p></div>}
        </div>
      </div>
      <p className="small muted m-only" style={{ display: 'block', marginTop: 6 }}>Tap a pin to find its card. Tap the card for details.</p>
    </>
  );
}
