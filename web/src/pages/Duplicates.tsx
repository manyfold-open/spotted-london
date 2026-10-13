import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { dateRange } from '../lib/format';
import { useErrorToast, useMe, useSheet, useToast } from '../lib/hooks';
import { duplicatePairs, type DuplicatePair } from '../../../src/shared/merge-candidates';
import { Icon } from '../components/Icon';
import { StatusTag } from '../components/PopupBits';
import { appUrl } from '../lib/base';

// Admin only. Pairs of listed pop-ups that may be the same one, found in the browser from the public list.
// It only suggests: "Keep this one" merges the other into it (see MergePanel), "Not the same" is remembered for everyone.

const SHOWN = 40;

function Side({ p, keep, armed, busy, onKeep, onOpen }: { p: Popup; keep: boolean; armed: boolean; busy: boolean; onKeep: () => void; onOpen: () => void }) {
  return (
    <div className="dup-side">
      <div className="row" style={{ gap: 6 }}><StatusTag status={p.status} />{keep ? <span className="tag t-eng"><Icon name="i-check" />Suggested to keep</span> : null}</div>
      <h3><a href={appUrl(`/p/${p.slug}`)} onClick={e => { e.preventDefault(); onOpen(); }}>{p.title}</a></h3>
      <div className="small muted">{p.location.address ?? p.location.borough ?? 'London'} · {dateRange(p)}{p.host ? ` · ${p.host}` : ''}</div>
      {p.source_url ? <a className="small" href={p.source_url} target="_blank" rel="noopener nofollow" style={{ overflowWrap: 'anywhere' }}>{p.source_url.replace(/^https?:\/\/(www\.)?/, '')}</a> : <span className="small muted">No source link</span>}
      <button className={`btn sm ${armed ? 'danger' : ''}`} disabled={busy} onClick={onKeep}>{busy ? <span className="spin" /> : <Icon name={armed ? 'i-link' : 'i-check'} />}{armed ? 'Tap again to merge the other into this' : 'Keep this one'}</button>
    </div>
  );
}

function PairCard({ pair, onMerge, onDismiss, busy }: { pair: DuplicatePair; onMerge: (remove: string, keep: string) => void; onDismiss: () => void; busy: boolean }) {
  const { open } = useSheet();
  const [armed, setArmed] = useState<'a' | 'b' | null>(null);
  const side = (k: 'a' | 'b') => {
    const mine = pair[k] as Popup, other = pair[k === 'a' ? 'b' : 'a'] as Popup;
    return <Side p={mine} keep={pair.keep === k} armed={armed === k} busy={busy && armed === k} onOpen={() => open(mine.slug)} onKeep={() => (armed === k ? onMerge(other.id, mine.id) : setArmed(k))} />;
  };
  return (
    <div className="panel dup" style={{ padding: 14 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{pair.why.map(w => <span key={w} className="tag t-line">{w}</span>)}</div>
      <div className="dup-grid">{side('a')}{side('b')}</div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn sm subtle" disabled={busy} onClick={onDismiss}><Icon name="i-x" />Not the same</button>
      </div>
    </div>
  );
}

export default function DuplicatesPage() {
  const { data: me, isPending } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const admin = me?.role === 'admin';
  const snap = useQuery({ queryKey: ['popups', 'snapshot'], queryFn: () => api<{ items: Popup[] }>('/popups/snapshot', { cache: 'no-cache' }), staleTime: 60_000, enabled: admin });
  const dismissed = useQuery({ queryKey: ['dup-dismissed'], queryFn: () => api<{ keys: string[] }>('/admin/duplicates/dismissed'), enabled: admin });
  const pairs = useMemo(() => (snap.data && dismissed.data ? duplicatePairs(snap.data.items, new Set(dismissed.data.keys)) : []), [snap.data, dismissed.data]);
  const [busy, setBusy] = useState<string | null>(null);
  const merge = useMutation({
    mutationFn: ({ remove, keep }: { remove: string; keep: string; key: string }) => api(`/admin/popups/${remove}/decision`, { method: 'POST', json: { action: 'merge', merge_into: keep } }),
    onMutate: v => setBusy(v.key),
    onSuccess: () => { toast('Merged. Its saves, links and photos moved over.', 'i-check'); qc.invalidateQueries({ queryKey: ['popups'] }); qc.invalidateQueries({ queryKey: ['queue'] }); },
    onError,
    onSettled: () => setBusy(null),
  });
  const dismiss = useMutation({
    mutationFn: (key: string) => api<{ keys: string[] }>('/admin/duplicates/dismissed', { method: 'POST', json: { key } }),
    onMutate: key => setBusy(key),
    onSuccess: d => { qc.setQueryData(['dup-dismissed'], d); toast('Got it. These two will not show up again.', 'i-check'); },
    onError,
    onSettled: () => setBusy(null),
  });
  if (isPending) return <div className="sk" style={{ height: 160, borderRadius: 16 }} />;
  if (!admin) return <div className="empty"><Icon name="i-shield" className="i big" /><h2>Admins only</h2><p>This page is for the people who review posts.</p><Link className="btn sm" to="/">Back to Explore</Link></div>;
  const loading = snap.isPending || dismissed.isPending;
  return (
    <>
      <Link className="btn sm subtle m-only" to="/me" style={{ margin: '-6px 0 8px -10px' }}><Icon name="i-left" className="i" />Back to Me</Link>
      <div className="eyebrow">Admin</div><h1>Possible duplicates</h1>
      <p className="intro">Listed pop-ups that are close together, run at the same time and share words in the title. It only suggests: a venue with two shows can show up here too, so check before you merge. Merging removes one, with no karma penalty, and moves its saves, links and photos to the one you keep.</p>
      <div className="lh"><h2>{loading ? 'Looking' : pairs.length === 1 ? '1 pair to check' : `${pairs.length} pairs to check`}</h2>{pairs.length > SHOWN ? <span className="muted small">Showing the best {SHOWN}</span> : null}</div>
      {loading ? <div className="stack">{[0, 1].map(i => <div key={i} className="sk-panel" style={{ height: 150 }} />)}</div>
        : pairs.length ? <div className="stack">{pairs.slice(0, SHOWN).map(pr => (
          <PairCard key={pr.key} pair={pr} busy={busy === pr.key} onDismiss={() => dismiss.mutate(pr.key)} onMerge={(remove, keep) => merge.mutate({ remove, keep, key: pr.key })} />
        ))}</div>
        : <div className="empty"><Icon name="i-checkc" className="i big" /><h2>No likely duplicates</h2><p>Nothing listed looks like the same pop-up twice.</p></div>}
    </>
  );
}
