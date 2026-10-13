import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { dateRange } from '../lib/format';
import { useErrorToast, useToast } from '../lib/hooks';
import { mergeCandidates } from '../../../src/shared/merge-candidates';
import { Icon } from './Icon';

/**
 * Admin only: say that this pop-up is the same as another one that is already listed. The copy is removed (no karma
 * penalty for the poster), and its saves, links and photos move to the one that stays. The server does the work
 * (`merge` in POST /admin/popups/:id/decision); this only picks the target from the list the browser already has.
 */
export function MergePanel({ p, onDone, onCancel }: { p: Pick<Popup, 'id' | 'title' | 'host' | 'start_at' | 'end_at' | 'location'>; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const snap = useQuery({ queryKey: ['popups', 'snapshot'], queryFn: () => api<{ items: Popup[] }>('/popups/snapshot', { cache: 'no-cache' }), staleTime: 60_000 });
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const items = snap.data?.items;
  const found = useMemo(() => (items ? mergeCandidates(items, p, text) : []), [items, p, text]);
  const chosen = items?.find(x => x.id === target);
  const merge = useMutation({
    mutationFn: () => api(`/admin/popups/${p.id}/decision`, { method: 'POST', json: { action: 'merge', merge_into: target } }),
    onSuccess: () => {
      toast('Merged. Its saves, links and photos moved over.', 'i-check');
      qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['popups'] });
      onDone();
    },
    onError,
  });
  return (
    <div className="panel merge" style={{ padding: 14 }}>
      <h3>Same as which pop-up?</h3>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>This one is removed, with no karma penalty for the poster. Its saves, links and photos move to the one you pick.</p>
      <input className="input" value={text} onChange={e => { setText(e.target.value); setTarget(null); }} placeholder="Search by title or host" aria-label="Search listed pop-ups" autoComplete="off" spellCheck={false} />
      <div className="stack" style={{ marginTop: 10, gap: 8 }}>
        {snap.isPending ? <p className="small muted">Loading the list</p>
          : found.length ? found.map(c => {
            const full = items!.find(x => x.id === c.id)!;
            return (
              <button key={c.id} type="button" className="mini" aria-pressed={target === c.id} onClick={() => setTarget(c.id)} style={target === c.id ? { background: 'var(--accent-soft, var(--card))', borderWidth: 3 } : undefined}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <b style={{ display: 'block' }}>{full.title}</b>
                  <span className="small muted">{full.location.borough ?? 'London'} · {dateRange(full)}{full.host ? ` · ${full.host}` : ''}</span>
                </span>
                {target === c.id ? <Icon name="i-check" className="i" /> : null}
              </button>
            );
          })
          : <p className="small muted">{text ? 'Nothing listed matches that.' : 'No likely match nearby. Search by title or host.'}</p>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="btn sm subtle" onClick={onCancel} disabled={merge.isPending}>Cancel</button>
        <button type="button" className="btn sm danger" disabled={!chosen || merge.isPending} onClick={() => merge.mutate()}>
          {merge.isPending ? <span className="spin" /> : <Icon name="i-link" />}{chosen ? 'Merge into this one' : 'Pick one first'}
        </button>
      </div>
    </div>
  );
}
