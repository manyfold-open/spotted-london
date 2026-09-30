import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Popup } from '../lib/api';
import { CATS, dateRange, isLive, PUBLIC } from '../lib/format';
import { currentPosition, useErrorToast, useMe, useRequireAuth, useSheet, useToast } from '../lib/hooks';
import { Icon } from './Icon';
import { Cover, hideBroken, Meter, ScoreVotes, StatusTag, usePopupActions } from './PopupBits';
import { Turnstile, useNeedsTurnstile } from './Turnstile';

// Same thresholds as src/lib/scoring.ts on the server (SPEC 4.3).
const VERIFY_CONFIDENCE = 0.75, VERIFY_MIN_WEIGHT = 8;

const REASONS: [string, string][] = [
  ['not_exist', 'It does not exist'], ['cancelled', 'Cancelled or closed'], ['wrong_details', 'Wrong details'],
  ['duplicate', 'Duplicate'], ['spam', 'Spam or advert'],
];

export function PopupSheet({ slug }: { slug: string }) {
  const { close } = useSheet();
  const q = useQuery({ queryKey: ['popup', slug], queryFn: () => api<Popup>(`/popups/${encodeURIComponent(slug)}`), retry: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [close]);

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={q.data?.title ?? 'Pop-up'}>
        {q.isPending ? <SheetSkeleton onClose={close} />
          : q.isError ? <SheetMissing onClose={close} notFound={q.error instanceof ApiError && q.error.status === 404} />
          : <SheetBody p={q.data} onClose={close} />}
      </aside>
    </>
  );
}

function SheetSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="dhead sk" style={{ borderRadius: 0 }}><span className="handle" /><button className="btn sm dclose" onClick={onClose} aria-label="Close"><Icon name="i-x" /></button></div>
      <div className="dbody"><div className="sk" style={{ height: 34, width: '70%' }} /><div className="sk" style={{ height: 80 }} /><div className="sk" style={{ height: 220 }} /></div>
    </>
  );
}

function SheetMissing({ onClose, notFound }: { onClose: () => void; notFound: boolean }) {
  return (
    <div className="dbody">
      <div className="row"><span className="spacer" /><button className="btn sm" onClick={onClose}><Icon name="i-x" />Close</button></div>
      <div className="empty"><Icon name="i-info" className="i big" /><h2>{notFound ? 'This pop-up is not available' : 'Could not load this pop-up'}</h2>
        <p style={{ marginTop: 6 }}>{notFound ? 'It may have been removed, or it is still waiting for review.' : 'Check your connection and try again.'}</p></div>
    </div>
  );
}

function SheetBody({ p, onClose }: { p: Popup; onClose: () => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const requireAuth = useRequireAuth();
  const { toggleSave } = usePopupActions(p);
  const [reporting, setReporting] = useState(false);
  const [locating, setLocating] = useState(false);
  const [botToken, setBotToken] = useState<string | null>(null);
  const needsBot = useNeedsTurnstile();

  const live = isLive(p);
  const started = p.start_at <= Date.now();
  const v = p.verification;
  const mine = p.me?.existence_vote ?? 0;
  const weight = p.me?.vote_weight ?? me?.vote_weight ?? 1;
  const own = !!me && p.posted_by?.id === me.id;
  const canVote = PUBLIC.includes(p.status) && !own;

  const after = (status_change: { from: string; to: string } | null) => {
    qc.invalidateQueries({ queryKey: ['popups'] });
    if (status_change?.to === 'hidden') {
      // It is no longer public, so reloading it would 404. Close and say what happened.
      toast('Thanks. Your vote hid this pop-up and sent it to an admin.', 'i-flag');
      qc.removeQueries({ queryKey: ['popup', p.slug] });
      onClose();
      return;
    }
    if (status_change?.to === 'verified_community') toast('Your vote verified this pop-up', 'i-checkc');
    qc.invalidateQueries({ queryKey: ['popup', p.slug] });
  };

  const exist = useMutation({
    mutationFn: (value: number) => api<{ status_change: { from: string; to: string } | null }>(`/popups/${p.id}/vote`, { method: 'PUT', json: { kind: 'existence', value } }),
    onSuccess: (d, value) => { if (value && !d.status_change) toast(`Vote counted at ${weight.toFixed(1)}x`); after(d.status_change); },
    onError,
  });
  const checkin = useMutation({
    mutationFn: async () => {
      setLocating(true);
      try {
        const [lat, lng] = await currentPosition();
        return await api<{ valid: boolean; message: string; status_change: { from: string; to: string } | null }>(`/popups/${p.id}/checkin`, { method: 'POST', json: { lat, lng } });
      } finally { setLocating(false); }
    },
    onSuccess: d => { toast(d.message, 'i-locate'); after(d.status_change); qc.invalidateQueries({ queryKey: ['me'] }); },
    onError,
  });
  const report = useMutation({
    mutationFn: (reason: string) => api<{ status_change: { from: string; to: string } | null }>(`/popups/${p.id}/report`, { method: 'POST', json: { reason, turnstile_token: botToken } }),
    onSuccess: d => { setReporting(false); if (d.status_change?.to !== 'hidden') toast('Report sent to the admins', 'i-flag'); after(d.status_change); },
    onError: e => { setReporting(false); onError(e); },
  });

  const checks = [
    { ok: v.confidence >= VERIFY_CONFIDENCE, text: `Confidence at least 75% (now ${Math.round(v.confidence * 100)}%)` },
    { ok: v.weighted_votes >= VERIFY_MIN_WEIGHT, text: `Weighted votes at least 8 (now ${v.weighted_votes.toFixed(1)})` },
    started
      ? { ok: v.checkins >= 1 || v.voters >= 3, text: `One check-in or 3 voters (now ${v.checkins} check-ins, ${v.voters} voters)` }
      : { ok: v.voters >= 5, text: `Not started yet, so 5 voters needed (now ${v.voters})` },
  ];

  const share = async () => {
    const url = `${location.origin}/p/${p.slug}`;
    try {
      if (navigator.share) await navigator.share({ title: p.title, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', 'i-link'); }
    } catch { /* cancelled */ }
  };

  return (
    <>
      <Cover p={p} className="dhead" />
      <span className="handle" />
      <button className="btn sm dclose" onClick={onClose} aria-label="Close"><Icon name="i-x" /><span className="d-only">Close</span></button>
      <div className="dbody">
        <div className="row" style={{ gap: 6 }}>
          <StatusTag status={p.status} />{p.example ? <span className="tag t-sim">Example</span> : null}<span className="tag t-mute">{CATS[p.category]}</span>
          {live ? <span className="tag t-new">On now</span> : null}
        </div>
        <div><h1 style={{ fontSize: 32 }}>{p.title}</h1>{p.host ? <p className="muted" style={{ marginTop: 4 }}>by {p.host}</p> : null}</div>
        <dl className="facts">
          <dt><Icon name="i-clock" />When</dt><dd className="num">{dateRange(p)}{p.hours_text ? <><br /><span className="muted">{p.hours_text}</span></> : null}</dd>
          <dt><Icon name="i-pin" />Where</dt><dd>{p.location.address ?? p.location.borough ?? 'London'}</dd>
          {p.price.text ? <><dt><Icon name="i-pound" />Price</dt><dd>{p.price.text}</dd></> : null}
          <dt><Icon name="i-ext" />Source</dt><dd>{p.source_url ? <a href={p.source_url} target="_blank" rel="noopener nofollow">{p.source_url.replace(/^https?:\/\/(www\.)?/, '')}</a> : <span className="muted">No link given</span>}</dd>
        </dl>
        {p.images && p.images.length > 1 ? <div className="gallery noscroll">{p.images.map(i => <img key={i.id} src={i.url} alt="" loading="lazy" onError={hideBroken} />)}</div> : null}
        {p.example ? <div className="notice small"><Icon name="i-info" /><span>This is an example pop-up that shows how Spotted works. It is not a real event.</span></div> : null}
        {p.description ? <p style={{ whiteSpace: 'pre-line' }}>{p.description}</p> : null}
        <div className="row"><span className="small muted">Worth going?</span><ScoreVotes p={p} /><span className="spacer" /><button className="btn sm subtle" onClick={share}><Icon name="i-link" />Share</button></div>

        {PUBLIC.includes(p.status) ? (
          <section className="panel">
            <div className="row"><h2>Is this real?</h2><span className="spacer" /><span className="small muted num">{v.voters} voters · {v.checkins} check-ins</span></div>
            <div className="confrow"><b className="num">{Math.round(v.confidence * 100)}%</b><span className="muted small">confidence from weighted votes</span></div>
            <Meter value={v.confidence} big />
            {p.status === 'verified_admin'
              ? <div className="notice small" style={{ marginTop: 12 }}><Icon name="i-shield" /><span>An admin checked this with the host.</span></div>
              : <ul className="checklist">{checks.map(c => <li key={c.text} className={c.ok ? 'ok' : 'no'}><Icon name={c.ok ? 'i-checkc' : 'i-clock'} /><span>{c.text}</span></li>)}</ul>}
            {own ? <p className="weightnote" style={{ marginTop: 14 }}>This is your post, so you cannot vote on it. You earn 10 karma when it is verified.</p> : (
              <>
                <div className="split" style={{ marginTop: 14 }}>
                  <button className={`btn yes ${mine === 1 ? 'on' : ''}`} disabled={!canVote || exist.isPending} onClick={requireAuth(() => exist.mutate(mine === 1 ? 0 : 1), 'Sign in to vote')}><Icon name="i-check" />It's real</button>
                  <button className={`btn no ${mine === -1 ? 'on' : ''}`} disabled={!canVote || exist.isPending} onClick={requireAuth(() => exist.mutate(mine === -1 ? 0 : -1), 'Sign in to vote')}><Icon name="i-x" />Fake</button>
                </div>
                <button className="btn block" style={{ marginTop: 10 }} disabled={!live || checkin.isPending} onClick={requireAuth(() => checkin.mutate(), 'Sign in to check in')}>
                  {locating ? <span className="spin" /> : <Icon name="i-locate" />}
                  {locating ? 'Finding you' : live ? "I'm here, check me in" : 'Check-in opens when it starts'}
                </button>
                <p className="weightnote" style={{ marginTop: 10 }}>
                  {me ? <>Your vote counts <b className="num">{weight.toFixed(1)}x</b>. Checked in within 200 m it counts <b className="num">{(weight * 3).toFixed(1)}x</b>. </> : null}
                  Match the final result for +1 karma, miss it for −2.
                </p>
              </>
            )}
          </section>
        ) : p.status === 'pending' ? (
          <div className="notice watch"><Icon name="i-clock" /><span>This post is waiting for an admin, so voting is closed for now.</span></div>
        ) : null}

        {p.posted_by ? <div className="small muted">Added by <b>{p.posted_by.name ?? 'a member'}</b> · karma {p.posted_by.karma}</div> : null}
        {!own && PUBLIC.includes(p.status) ? (
          reporting ? (
            <div className="panel" style={{ padding: 14 }}>
              <h3>What's wrong?</h3>
              <div className="chips" style={{ marginTop: 10 }}>
                {REASONS.map(([k, l]) => <button key={k} className="chip" disabled={report.isPending || (needsBot && !botToken)} onClick={() => report.mutate(k)}>{l}</button>)}
              </div>
              <div style={{ marginTop: 10 }}><Turnstile onToken={setBotToken} /></div>
            </div>
          ) : <div><button className="btn sm subtle" onClick={requireAuth(() => setReporting(true), 'Sign in to report')}><Icon name="i-flag" />Report a problem</button></div>
        ) : null}
      </div>
      <div className="dfoot">
        <button className="btn" aria-pressed={!!p.me?.saved} onClick={toggleSave}><Icon name="i-bookmark" />{p.me?.saved ? 'Saved' : 'Save'}</button>
        <a className="btn primary" href={`https://www.google.com/maps/search/?api=1&query=${p.location.lat},${p.location.lng}`} target="_blank" rel="noopener"><Icon name="i-route" />Directions</a>
      </div>
    </>
  );
}
