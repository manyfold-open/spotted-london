import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { CATS, catIcon, dateRange, distance, isLive, meterClass, startsTomorrow } from '../lib/format';
import { useErrorToast, useRequireAuth, useSheet, useToast } from '../lib/hooks';
import { Icon } from './Icon';

export function StatusTag({ status }: { status: Popup['status'] }) {
  switch (status) {
    case 'verified_admin': return <span className="tag t-ink"><Icon name="i-shield" />Verified</span>;
    case 'verified_community': return <span className="tag t-eng"><Icon name="i-checkc" />Community verified</span>;
    case 'community': return <span className="tag t-watch">Being checked</span>;
    case 'pending': return <span className="tag t-mute">Waiting for review</span>;
    case 'hidden': return <span className="tag t-err">Hidden</span>;
    case 'removed': return <span className="tag t-err">Removed</span>;
    case 'ended': return <span className="tag t-mute">Ended</span>;
  }
}

export function Meter({ value, big }: { value: number; big?: boolean }) {
  return (
    <div className={`meter ${meterClass(value)} ${big ? 'big' : ''}`} role="img" aria-label={`Confidence ${Math.round(value * 100)}%`}>
      <i style={{ width: `${Math.max(4, value * 100)}%` }} />
    </div>
  );
}

/** Cover photo, or the category's pattern and icon when there is no photo yet. */
export function Cover({ p, className }: { p: Pick<Popup, 'category' | 'cover_url'>; className: string }) {
  return (
    <div className={`${className} pat-${p.category}`}>
      {p.cover_url ? <img src={p.cover_url} alt="" loading="lazy" /> : <Icon name={catIcon(p.category)} className="i big" />}
    </div>
  );
}

/** Keeps every list in sync after a save or vote. */
export function usePopupActions(p: Popup) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const requireAuth = useRequireAuth();
  const refresh = (next?: Popup) => {
    if (next) qc.setQueryData(['popup', p.slug], (old: Popup | undefined) => (old ? { ...old, ...next, me: old.me } : old));
    qc.invalidateQueries({ queryKey: ['popups'] });
    qc.invalidateQueries({ queryKey: ['popup', p.slug] });
    qc.invalidateQueries({ queryKey: ['saves'] });
  };
  const save = useMutation({
    mutationFn: (on: boolean) => api(`/popups/${p.id}/save`, { method: on ? 'PUT' : 'DELETE', json: on ? {} : undefined }),
    onSuccess: (_d, on) => { toast(on ? "Saved. We'll remind you the day before." : 'Removed from saved', 'i-bookmark'); refresh(); },
    onError,
  });
  const quality = useMutation({
    mutationFn: (value: number) => api<{ popup: Popup }>(`/popups/${p.id}/vote`, { method: 'PUT', json: { kind: 'quality', value } }),
    onSuccess: d => refresh(d.popup),
    onError,
  });
  return {
    toggleSave: requireAuth(() => save.mutate(!p.me?.saved), 'Sign in to save pop-ups'),
    voteQuality: requireAuth((v: number) => quality.mutate(p.me?.quality_vote === v ? 0 : v), 'Sign in to vote'),
    busy: save.isPending || quality.isPending,
  };
}

export function ScoreVotes({ p }: { p: Popup }) {
  const { voteQuality } = usePopupActions(p);
  const mine = p.me?.quality_vote ?? 0;
  return (
    <div className="score">
      <button className="vote" aria-pressed={mine === 1} aria-label="Upvote" onClick={e => { e.stopPropagation(); voteQuality(1); }}><Icon name="i-up" /></button>
      <span className="num">{p.score}</span>
      <button className="vote" aria-pressed={mine === -1} aria-label="Downvote" onClick={e => { e.stopPropagation(); voteQuality(-1); }}><Icon name="i-down" /></button>
    </div>
  );
}

export function PopupCard({ p }: { p: Popup }) {
  const { open } = useSheet();
  const { toggleSave } = usePopupActions(p);
  const live = isLive(p);
  return (
    <article className="card">
      <div className={`thumb pat-${p.category}`}>
        {p.cover_url ? <img src={p.cover_url} alt="" loading="lazy" /> : <Icon name={catIcon(p.category)} className="i big" />}
        {live ? <span className="tag t-new live">On now</span> : startsTomorrow(p) ? <span className="tag t-out live">Tomorrow</span> : null}
        <button className="save" aria-pressed={!!p.me?.saved} aria-label={p.me?.saved ? 'Remove from saved' : 'Save'} onClick={toggleSave}><Icon name="i-bookmark" /></button>
      </div>
      <div className="cbody">
        <div className="row" style={{ gap: 6 }}><StatusTag status={p.status} />{p.example ? <span className="tag t-sim">Example</span> : null}<span className="tag t-mute cattag">{CATS[p.category]}</span></div>
        <h3><Link className="stretch" to={`/p/${p.slug}`} onClick={e => { e.preventDefault(); open(p.slug); }}>{p.title}</Link></h3>
        <div className="meta"><Icon name="i-pin" /><span className="t">{[p.location.borough, p.host].filter(Boolean).join(' · ')}{p.distance_m !== undefined ? ` · ${distance(p.distance_m)}` : ''}</span></div>
        <div className="meta"><Icon name="i-clock" /><span className="t num">{dateRange(p)}</span></div>
      </div>
      <div className="cfoot">
        <span className="small muted num">{Math.round(p.verification.confidence * 100)}% real</span>
        <Meter value={p.verification.confidence} />
        <ScoreVotes p={p} />
      </div>
    </article>
  );
}

export function CardSkeletons({ n = 6 }: { n?: number }) {
  return <div className="grid" aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} className="sk sk-card" />)}</div>;
}
