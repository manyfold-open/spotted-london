import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, listParams, type Popup } from '../lib/api';
import { filterPopups } from '../../../src/shared/filter-popups';
import { forYou, hiddenCategories, syncActions } from '../../../src/shared/taste';
import { updateTaste, useTaste } from '../lib/taste';
import { useAsk, useAskStatus } from '../lib/ask';
import { CAT_LIST, CATS, catIcon } from '../lib/format';
import { mergeMe } from '../lib/cache';
import { useDebounced, useFilters, useMe, useMyState } from '../lib/hooks';
import { Icon } from './Icon';
import { track } from '../lib/track';
import { emptyEvent } from '../../../src/shared/tracking';

const WHENS = [['today', 'Today'], ['weekend', 'This weekend'], ['week', 'Next 7 days'], ['all', 'All upcoming']] as const;

/** The last empty result counted, so the same empty list is not counted again as the page re-renders. */
let lastEmpty = '';

/**
 * The public list is fetched once, whole, and filtered here, so changing a filter or typing in the search
 * box sends no request. The key starts with 'popups', so the places that refresh or patch lists reach it.
 */
export function usePopups(near?: [number, number] | null) {
  const f = useFilters();
  const q = useDebounced(f.q, 250);
  const snap = useQuery({
    queryKey: ['popups', 'snapshot'],
    // revalidate with the ETag: one row read when nothing changed, and a pop-up you just added shows up
    queryFn: () => api<{ items: Popup[] }>('/popups/snapshot', { cache: 'no-cache' }),
    staleTime: 60_000,
  });
  const mine = useMyState();
  const { data: me } = useMe();
  const taste = useTaste();
  const picked = taste.on && taste.swipes > 0; // "For you" is on and there is something to go on
  // Saves and quality votes teach the taste too. This counts the ones you have now (also those from before this
  // existed), takes back the ones you removed, and does nothing when they are already counted.
  // Only from the account: what you saved on this device while signed out only shows as bookmarks until it moves over.
  useEffect(() => { const items = snap.data?.items; if (items && mine && me) updateTaste(t => syncActions(t, items, mine)); }, [snap.data, mine, me]);
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => { const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000); return () => clearInterval(t); }, []); // "today" and "on now" move with the clock
  const [lat, lng] = near ?? [];
  const data = useMemo(() => {
    if (!snap.data) return undefined;
    const params = listParams({ when: f.when, category: f.category, verified: f.verified, q, ...(near ? { near, radius_km: 3, sort: 'distance' as const } : {}) });
    const page = filterPopups(snap.data.items, { ...params, limit: 'all' }, Date.now()); // all of them: the map and the count must not stop at one page of 50
    // For you: re-order by taste and drop categories you said no to (unless you picked a category yourself)
    // (a saved pop-up is never left out for its category: you picked it yourself)
    const items = picked ? forYou(page.items, taste, !!f.category || f.saved) : page.items;
    // Saved: your saves (on the account, or on this device when signed out) narrow the list and the map, here and never on the server
    const saved = f.saved ? new Set(mine?.saved ?? []) : null;
    return { ...page, items: mergeMe(saved ? items.filter(p => saved.has(p.id)) : items, mine) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `near` is rebuilt on every render; lat and lng stand in for it
  }, [snap.data, f.when, f.category, f.verified, f.saved, q, lat, lng, mine, minute, picked, taste]);
  // A search or filter that finds nothing says what people look for and cannot find. Fixed words only (never the search text),
  // once for each combination, and only when the list itself has pop-ups, so a list that has not loaded is not blamed on a filter.
  useEffect(() => {
    if (data?.items.length) lastEmpty = ''; // results again: the next empty list counts
    if (!data || !snap.data?.items.length || data.items.length) return;
    const seen = emptyEvent({ q, cat: f.category, verified: f.verified, saved: f.saved, when: f.when });
    if (!seen) return;
    const key = `${seen.name}:${seen.detail}`;
    if (key === lastEmpty) return;
    lastEmpty = key;
    track(seen.name, { detail: seen.detail || undefined });
  }, [data, snap.data, q, f.category, f.verified, f.saved, f.when]);
  return { ...snap, data, all: snap.data?.items, forYou: picked, hidden: picked && !f.category && !f.saved ? hiddenCategories(taste) : [] };
}

/**
 * The When and Category chips. `inline` puts everything in one row that scrolls sideways (the phone, floating
 * over the map); otherwise there are two rows (the desktop panel).
 */
export function Filters({ near, locating, onNear, inline, onPick, onAsk }: { near: boolean; locating: boolean; onNear: () => void; inline?: boolean; onPick: () => void; onAsk?: () => void }) {
  const f = useFilters();
  const taste = useTaste();
  // Ask only shows while a Concierge agent is on. A new answer you have not looked at yet gets a dot.
  const askOn = useAskStatus().data?.available && !!onAsk;
  const asked = useAsk();
  const askChip = askOn ? (
    <button className="chip ask" onClick={onAsk}><Icon name="i-bolt" />Ask{asked.unseen ? <><span className="dot" aria-hidden="true" /><span className="sr">, new answer</span></> : null}</button>
  ) : null;
  const on = taste.on && taste.swipes > 0;
  // First time (no answers yet): the chip opens the swipe. After that it switches the personal order on and off.
  const youChip = <button className="chip you" aria-pressed={on} onClick={() => (taste.swipes > 0 ? updateTaste(t => ({ ...t, on: !t.on })) : onPick())}><Icon name="i-sparkle" />For you</button>;
  const nearChip = <button className="chip" aria-pressed={near} onClick={onNear}>{locating ? <span className="spin" /> : <Icon name="i-locate" />}Near me</button>;
  // Turning Saved on also widens the dates to all upcoming, so a save for next month is not hidden by "Next 7 days"
  const savedChip = <button className="chip" aria-pressed={f.saved} onClick={() => f.set(f.saved ? { saved: null } : { saved: '1', when: 'all' })}><Icon name="i-bookmark" />Saved</button>;
  const whens = WHENS.map(([k, l]) => <button key={k} className="chip" aria-pressed={f.when === k} onClick={() => f.set({ when: k === 'week' ? null : k })}>{l}</button>);
  const cats = (
    <>
      <button className="chip" aria-pressed={!f.category} onClick={() => f.set({ cat: null })}>All</button>
      {CAT_LIST.map(c => <button key={c} className="chip" aria-pressed={f.category === c} onClick={() => f.set({ cat: f.category === c ? null : c })}><span className={`cdot cc-${c}`}><Icon name={catIcon(c)} /></span>{CATS[c]}</button>)}
    </>
  );
  if (inline) {
    return (
      <div className="chips noscroll" role="group" aria-label="Filters">
        {askChip}{youChip}{nearChip}{savedChip}{whens}
        <button className="chip" aria-pressed={f.verified} onClick={() => f.set({ verified: f.verified ? null : '1' })}><Icon name="i-shield" />Verified</button>
        <span className="mp-sep" aria-hidden="true" />{cats}
      </div>
    );
  }
  return (
    <div className="filters">
      <div className="chips noscroll" role="group" aria-label="When">{askChip}{youChip}{nearChip}{savedChip}{whens}</div>
      <div className="chips noscroll" role="group" aria-label="Category">{cats}</div>
    </div>
  );
}

export function VerifiedSwitch() {
  const f = useFilters();
  return (
    <button className="switch" role="switch" aria-checked={f.verified} onClick={() => f.set({ verified: f.verified ? null : '1' })}>
      <span className="track" />Verified only
    </button>
  );
}

export function Newsletter() {
  return (
    <div className="notice note" style={{ marginTop: 24, alignItems: 'center' }}>
      <Icon name="i-mail" />
      <div style={{ flex: 1, minWidth: 0 }}><b>Weekly digest, coming soon</b><br /><span className="small">The ten best verified pop-ups, once a week. Sign-up is not open yet.</span></div>
    </div>
  );
}
