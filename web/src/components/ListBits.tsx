import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, listParams, type Popup } from '../lib/api';
import { filterPopups } from '../../../src/shared/filter-popups';
import { forYou, hiddenCategories } from '../../../src/shared/taste';
import { updateTaste, useTaste } from '../lib/taste';
import { CAT_LIST, CATS, catIcon, looksLikeEmail } from '../lib/format';
import { mergeMe } from '../lib/cache';
import { useDebounced, useErrorToast, useFilters, useMe, useMyState } from '../lib/hooks';
import { Icon } from './Icon';

const WHENS = [['today', 'Today'], ['weekend', 'This weekend'], ['week', 'Next 7 days'], ['all', 'All upcoming']] as const;

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
  const taste = useTaste();
  const picked = taste.on && taste.swipes > 0; // "For you" is on and there is something to go on
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => { const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000); return () => clearInterval(t); }, []); // "today" and "on now" move with the clock
  const [lat, lng] = near ?? [];
  const data = useMemo(() => {
    if (!snap.data) return undefined;
    const params = listParams({ when: f.when, category: f.category, verified: f.verified, q, ...(near ? { near, radius_km: 3, sort: 'distance' as const } : {}) });
    const page = filterPopups(snap.data.items, { ...params, limit: 'all' }, Date.now()); // all of them: the map and the count must not stop at one page of 50
    // For you: re-order by taste and drop categories you said no to (unless you picked a category yourself)
    const items = picked ? forYou(page.items, taste, !!f.category) : page.items;
    return { ...page, items: mergeMe(items, mine) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `near` is rebuilt on every render; lat and lng stand in for it
  }, [snap.data, f.when, f.category, f.verified, q, lat, lng, mine, minute, picked, taste]);
  return { ...snap, data, all: snap.data?.items, forYou: picked, hidden: picked && !f.category ? hiddenCategories(taste) : [] };
}

/**
 * The When and Category chips. `inline` puts everything in one row that scrolls sideways (the phone, floating
 * over the map); otherwise there are two rows (the desktop panel).
 */
export function Filters({ near, locating, onNear, inline, onPick }: { near: boolean; locating: boolean; onNear: () => void; inline?: boolean; onPick: () => void }) {
  const f = useFilters();
  const taste = useTaste();
  const on = taste.on && taste.swipes > 0;
  // First time (no answers yet): the chip opens the swipe. After that it switches the personal order on and off.
  const youChip = <button className="chip you" aria-pressed={on} onClick={() => (taste.swipes > 0 ? updateTaste(t => ({ ...t, on: !t.on })) : onPick())}><Icon name="i-sparkle" />For you</button>;
  const nearChip = <button className="chip" aria-pressed={near} onClick={onNear}>{locating ? <span className="spin" /> : <Icon name="i-locate" />}Near me</button>;
  const whens = WHENS.map(([k, l]) => <button key={k} className="chip" aria-pressed={f.when === k} onClick={() => f.set({ when: k === 'week' ? null : k })}>{l}</button>);
  const cats = (
    <>
      <button className="chip" aria-pressed={!f.category} onClick={() => f.set({ cat: null })}>All</button>
      {CAT_LIST.map(c => <button key={c} className="chip" aria-pressed={f.category === c} onClick={() => f.set({ cat: f.category === c ? null : c })}><Icon name={catIcon(c)} />{CATS[c]}</button>)}
    </>
  );
  if (inline) {
    return (
      <div className="chips noscroll" role="group" aria-label="Filters">
        {youChip}{nearChip}{whens}
        <button className="chip" aria-pressed={f.verified} onClick={() => f.set({ verified: f.verified ? null : '1' })}><Icon name="i-shield" />Verified</button>
        <span className="mp-sep" aria-hidden="true" />{cats}
      </div>
    );
  }
  return (
    <div className="filters">
      <div className="chips noscroll" role="group" aria-label="When">{youChip}{nearChip}{whens}</div>
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
  const { data: me } = useMe();
  const [email, setEmail] = useState('');
  const [bad, setBad] = useState(false);
  const onError = useErrorToast();
  const sub = useMutation({ mutationFn: (e: string) => api('/newsletter/subscribe', { method: 'POST', json: { email: e } }), onError });
  if (sub.isSuccess) return <div className="notice good" style={{ marginTop: 24 }}><Icon name="i-mail" /><span>Check your inbox to confirm. The first issue lands on Thursday morning.</span></div>;
  return (
    <div className="notice note" style={{ marginTop: 24, alignItems: 'center', flexWrap: 'wrap' }}>
      <Icon name="i-mail" />
      <div style={{ flex: 1, minWidth: 180 }}><b>This Weekend in London Pop-ups</b><br /><span className="small">The ten best verified pop-ups, every Thursday.</span></div>
      <form className="newsform" noValidate onSubmit={e => {
        e.preventDefault();
        if (!me && !looksLikeEmail(email)) return setBad(true);
        sub.mutate(me?.email ?? email.trim());
      }}>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          {me ? null : <label style={{ flex: 1, minWidth: 0 }}><span className="sr">Email</span><input className={`input ${bad ? 'bad' : ''}`} type="email" inputMode="email" autoComplete="email" value={email}
            onChange={e => { setEmail(e.target.value); setBad(false); }} placeholder="you@email.com" style={{ minHeight: 38, borderRadius: 999 }} aria-invalid={bad} aria-describedby={bad ? 'newserr' : undefined} /></label>}
          <button className="btn primary sm" disabled={sub.isPending}>{sub.isPending ? <span className="spin" /> : null}{me ? 'Subscribe with my email' : 'Subscribe'}</button>
        </div>
        {bad ? <span className="ferr" id="newserr" role="alert">Enter an email address like name@example.com.</span> : null}
      </form>
    </div>
  );
}
