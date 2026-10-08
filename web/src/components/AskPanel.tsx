import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AskPick, Popup } from '../lib/api';
import { ask, clearAsk, markAskSeen, useAsk, useAskStatus } from '../lib/ask';
import { CATS, catIcon, dateRange, distance, isLive } from '../lib/format';
import { useTaste } from '../lib/taste';
import { haversine } from '../../../src/lib/geo';
import { meanwhile } from '../../../src/shared/ask-quick';
import { ASK_PER_VISITOR, ASK_RESTING, askLimited } from '../../../src/shared/ask-messages';
import { tasteSummary } from '../../../src/shared/taste';
import { Icon } from './Icon';
import { Img } from './PopupBits';
import { Turnstile } from './Turnstile';

const EXAMPLES = ['Free and a bit weird this weekend', 'Something to eat on Saturday', 'A good date idea near me'];
const SLOW_MS = 25_000;
const SHOWN = 5;

/**
 * Ask: type what you want, get up to 5 real pop-ups with a reason each. An agent answers in about ten seconds.
 * Until then (and when it cannot answer) the panel shows what the filters and "For you" would pick for those
 * words, so it is never a blank wait. `items` is the public list; `nearPos` is your position if you shared it,
 * and it stays here: it is only used to put the nearest first.
 */
export function AskPanel({ items, nearPos, onClose, onOpen }: { items: Popup[]; nearPos: [number, number] | null; onClose: () => void; onOpen: (slug: string) => void }) {
  const qc = useQueryClient();
  const a = useAsk();
  const status = useAskStatus();
  const taste = useTaste();
  const [text, setText] = useState(a.question);
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const s = status.data;
  const busy = a.phase === 'sending' || a.phase === 'pending';
  const summary = useMemo(() => tasteSummary(taste), [taste]);
  const botCheck = !!s?.needs_bot_check && !!s.turnstile_site_key;
  const closed = a.blocked || !!s?.resting || (s ? s.left <= 0 : false);
  const max = s?.max_chars ?? 300;
  // Said again when the panel is opened later in the day, not only right after the answer that hit the limit
  const limitNote = a.phase === 'failed' ? null : s?.resting ? ASK_RESTING : s && s.left <= 0 ? askLimited(s.per_visitor ?? ASK_PER_VISITOR) : null;
  const ready = text.trim().length >= 3 && !busy && !closed && (!botCheck || !!token);

  // The answer is being looked at now. Keep the question in the box when the panel is opened again.
  useEffect(() => { markAskSeen(); }, [a.phase]);
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    if (a.phase !== 'pending' && a.phase !== 'sending') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [a.phase]);

  // Escape closes, Tab stays inside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab') return;
      const f = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href]') ?? [])];
      if (!f.length) return;
      const at = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    void ask(qc, { text, taste: summary, nearMe: !!nearPos, token }).finally(() => { setToken(null); setReset(n => n + 1); });
  };

  const byId = useMemo(() => new Map(items.map(p => [p.id, p])), [items]);
  // The answer, put in order of distance when the agent says the request was about where you are.
  const shown = useMemo(() => {
    const rows = a.picks.map(p => ({ pick: p, item: byId.get(p.id) ?? null }));
    if (a.near && nearPos) {
      const d = (r: { item: Popup | null }) => (r.item ? haversine(nearPos[0], nearPos[1], r.item.location.lat, r.item.location.lng) : Infinity);
      return rows.map(r => ({ ...r, m: d(r) })).sort((x, y) => x.m - y.m).slice(0, SHOWN).map(r => ({ ...r, m: Number.isFinite(r.m) ? r.m : undefined }));
    }
    return rows.slice(0, SHOWN).map(r => ({ ...r, m: undefined as number | undefined }));
  }, [a.picks, a.near, nearPos, byId]);
  const elsewhere = useMemo(() => (a.question ? meanwhile(items, a.question, taste, Date.now(), SHOWN) : []), [items, a.question, taste]);
  const slow = a.phase === 'pending' && now - a.startedAt > SLOW_MS;

  return (
    <div className="ask-wrap" role="dialog" aria-modal="true" aria-labelledby="ask-title" ref={box}>
      <div className="ask-col">
        <div className="td-head">
          <div><b id="ask-title">Ask</b><small>Say what you are after. Spotted picks from what is on.</small></div>
          <button type="button" className="mp-x" aria-label="Close" onClick={onClose}><Icon name="i-x" /></button>
        </div>

        <form className="ask-form" noValidate onSubmit={submit}>
          <label htmlFor="ask-q" className="sr">What are you after?</label>
          <textarea id="ask-q" ref={field} className={`input ${a.error ? 'bad' : ''}`} rows={2} maxLength={max} value={text} disabled={closed}
            placeholder="Something free and a bit weird this weekend near Shoreditch"
            aria-invalid={!!a.error} aria-describedby={a.error ? 'ask-err' : 'ask-fine'}
            onChange={e => { setText(e.target.value); if (a.error) clearAsk(); }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
          {a.error ? <span className="ferr" id="ask-err" role="alert">{a.error}</span> : null}
          {!text && !busy && !closed ? (
            <div className="chips ask-ex" role="group" aria-label="Examples">
              {EXAMPLES.map(x => <button key={x} type="button" className="chip" onClick={() => { setText(x); field.current?.focus(); }}>{x}</button>)}
            </div>
          ) : null}
          {botCheck && !closed ? <Turnstile onToken={setToken} resetKey={reset} /> : null}
          <div className="row ask-go">
            <button className="btn primary" disabled={!ready}>{busy ? <span className="spin" /> : <Icon name="i-bolt" />}{busy ? 'Asking' : 'Ask'}</button>
            <span className="small muted num" aria-live="polite">{closed ? '' : s ? `${s.left} question${s.left === 1 ? '' : 's'} left today` : ''}</span>
          </div>
          <p className="ask-fine" id="ask-fine"><Icon name="i-info" /><span>Your question is sent to Spotted's AI helper{summary ? ', with a short summary of what you like' : ''}.{nearPos ? ' Your location stays on this device.' : ''}</span></p>
        </form>

        <div className="ask-out" aria-live="polite">
          {limitNote ? <div className="notice note" role="status"><Icon name="i-info" /><span>{limitNote}</span></div> : null}
          {busy ? (
            <p className="ask-state"><span className="spin" />{slow ? 'Taking longer than usual. You can keep waiting, or close this and carry on: the list below still works.' : 'Asking. This usually takes about ten seconds.'}</p>
          ) : null}
          {a.phase === 'failed' && a.message ? <div className="notice err" role="alert"><Icon name="i-info" /><span>{a.message}</span></div> : null}
          {a.phase === 'done' ? (
            shown.length ? (
              <>
                <h2 className="ask-h">{shown.length === 1 ? 'One pop-up for you' : `${shown.length} pop-ups for you`}</h2>
                {a.note ? <p className="small muted">{a.note}</p> : null}
                <ul className="ask-list">{shown.map(r => <AskRow key={r.pick.id} pick={r.pick} p={r.item} metres={r.m} onOpen={onOpen} />)}</ul>
              </>
            ) : <div className="notice note"><Icon name="i-info" /><span>{a.note || 'Nothing on Spotted matches that right now. Try other words, or use the filters.'}</span></div>
          ) : null}
          {a.phase !== 'idle' && (busy || a.phase === 'failed' || (a.phase === 'done' && !shown.length)) && elsewhere.length ? (
            <>
              <h2 className="ask-h">{busy ? 'While you wait' : 'Still on the list'}</h2>
              <p className="small muted">{busy ? 'What the filters and For you would pick for those words.' : 'What the filters and For you pick for those words.'}</p>
              <ul className="ask-list">{elsewhere.map(p => <AskRow key={p.id} p={p} onOpen={onOpen} />)}</ul>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AskRow({ pick, p, metres, onOpen }: { pick?: AskPick; p: Popup | null; metres?: number; onOpen: (slug: string) => void }) {
  const slug = p?.slug ?? pick?.slug ?? '';
  const title = p?.title ?? pick?.title ?? '';
  return (
    <li>
      <a className="ask-item" href={`/p/${slug}`} onClick={e => { e.preventDefault(); onOpen(slug); }}>
        <span className={`sw ${p ? `pat-${p.category}` : ''}`}>{p ? (p.cover_url ? <Img src={p.cover_url} /> : <Icon name={catIcon(p.category)} className="i" />) : <Icon name="i-pin" className="i" />}</span>
        <span className="ask-t">
          <b>{title}</b>
          {p ? <span className="ask-m">{[p.location.borough, CATS[p.category]].filter(Boolean).join(' · ')} · {dateRange(p)}{isLive(p) ? ' · on now' : ''}{p.price.type === 'free' ? ' · Free' : ''}</span> : null}
          {pick?.reason ? <span className="ask-why">{pick.reason}</span> : null}
        </span>
        {metres !== undefined ? <span className="mp-dist">{distance(metres)}</span> : null}
      </a>
    </li>
  );
}
