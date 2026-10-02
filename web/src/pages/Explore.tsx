import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, listQuery, type Popup } from '../lib/api';
import { CAT_LIST, CATS, catIcon, fmtDay, isLive, looksLikeEmail } from '../lib/format';
import { mergeMe } from '../lib/cache';
import { currentPosition, useDebounced, useErrorToast, useFilters, useMe, useMyState } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { CardSkeletons, PopupCard } from '../components/PopupBits';

const WHENS = [['today', 'Today'], ['weekend', 'This weekend'], ['week', 'Next 7 days'], ['all', 'All upcoming']] as const;

export function usePopups(near?: [number, number] | null) {
  const f = useFilters();
  const q = useDebounced(f.q, 250); // one request when typing pauses, not one per letter
  const params = { when: f.when, category: f.category, verified: f.verified, q, ...(near ? { near, radius_km: 3, sort: 'distance' as const } : {}) };
  const res = useQuery({
    queryKey: ['popups', params],
    queryFn: () => api<{ items: Popup[] }>(`/popups?${listQuery(params)}`),
    placeholderData: prev => prev,
  });
  // The list is the same for everyone; your saves and votes come separately and are laid over it here.
  const mine = useMyState();
  const data = useMemo(() => res.data && { ...res.data, items: mergeMe(res.data.items, mine) }, [res.data, mine]);
  return { ...res, data };
}

export function Filters({ near, setNear }: { near?: [number, number] | null; setNear?: (v: [number, number] | null) => void }) {
  const f = useFilters();
  const onError = useErrorToast();
  const [locating, setLocating] = useState(false);
  const toggleNear = async () => {
    if (!setNear) return;
    if (near) return setNear(null);
    setLocating(true);
    try { setNear(await currentPosition()); } catch (e) { onError(e); } finally { setLocating(false); }
  };
  return (
    <div className="filters">
      <div className="chips noscroll" role="group" aria-label="When">
        {setNear ? <button className="chip" aria-pressed={!!near} onClick={toggleNear}>{locating ? <span className="spin" /> : <Icon name="i-locate" />}Near me</button> : null}
        {WHENS.map(([k, l]) => <button key={k} className="chip" aria-pressed={f.when === k} onClick={() => f.set({ when: k === 'week' ? null : k })}>{l}</button>)}
      </div>
      <div className="chips noscroll" role="group" aria-label="Category">
        <button className="chip" aria-pressed={!f.category} onClick={() => f.set({ cat: null })}>All</button>
        {CAT_LIST.map(c => <button key={c} className="chip" aria-pressed={f.category === c} onClick={() => f.set({ cat: f.category === c ? null : c })}><Icon name={catIcon(c)} />{CATS[c]}</button>)}
      </div>
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

export function Explore() {
  const [near, setNear] = useState<[number, number] | null>(null);
  const q = usePopups(near);
  const f = useFilters();
  const items = q.data?.items ?? [];
  const live = items.filter(p => isLive(p));
  return (
    <>
      <div className="eyebrow">London · {fmtDay(Date.now())}</div>
      <h1><span className="d-only">What's popping up this week</span><span className="m-only">What's on this week</span></h1>
      <p className="intro d-only">Pop-ups added by locals and checked by the people who went. Live and verified ones come first, then the ones starting soon.</p>
      <Filters near={near} setNear={setNear} />
      {items.some(p => p.example) ? <div className="notice small" style={{ marginTop: 14 }}><Icon name="i-info" /><span>Pop-ups marked <b>Example</b> show how Spotted works. They are not real events.</span></div> : null}

      {live.length && f.when !== 'today' ? (
        <div className="m-only" style={{ display: 'block' }}>
          <div className="lh"><h2>Happening now</h2><span className="muted small">{live.length} open</span></div>
          <div className="carousel noscroll">{live.map((p, i) => <PopupCard key={p.id} p={p} i={i} />)}</div>
        </div>
      ) : null}

      <div className="lh">
        <h2>{q.isPending ? 'Loading' : `${items.length} pop-up${items.length === 1 ? '' : 's'}`}{near ? ' near you' : ''}</h2>
        <span className="muted small d-only">{live.length} on right now</span>
        <span className="spacer" /><VerifiedSwitch />
      </div>
      {q.isPending ? <CardSkeletons /> : q.isError ? (
        <div className="notice err"><Icon name="i-info" /><span>{q.error.message}</span><button className="btn sm" onClick={() => q.refetch()}>Try again</button></div>
      ) : items.length ? (
        <div className={`grid ${q.isPlaceholderData ? 'stale' : ''}`}>{items.map((p, i) => <PopupCard key={p.id} p={p} i={i} />)}</div>
      ) : (
        <div className="empty"><Icon name="i-search" className="i big" /><h2>Nothing here yet</h2><p>Try a wider date range or another category, or be the first to add one.</p><Link className="btn sm" to="/add"><Icon name="i-plus" />Add a pop-up</Link></div>
      )}
      <Newsletter />
    </>
  );
}

function Newsletter() {
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
