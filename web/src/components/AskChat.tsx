import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AskPick, Popup } from '../lib/api';
import { ask, clearAsk, clearAskError, closeAsk, isAsking, markAskSeen, useAsk, useAskStatus, type Turn } from '../lib/ask';
import { CATS, catIcon, dateRange, distance, isLive } from '../lib/format';
import { isPhone } from '../lib/motion';
import { useTaste } from '../lib/taste';
import { composeQuestion, REFINE_LABELS, shapePicks, type Refine } from '../../../src/shared/ask-chat';
import { meanwhile } from '../../../src/shared/ask-quick';
import { ASK_PER_VISITOR, ASK_RESTING, askLimited } from '../../../src/shared/ask-messages';
import { tasteSummary } from '../../../src/shared/taste';
import { Icon } from './Icon';
import { Img } from './PopupBits';
import { Turnstile } from './Turnstile';
import { appUrl } from '../lib/base';

const EXAMPLES = ['Free and a bit weird this weekend', 'Something to eat on Saturday', 'A good date idea near me'];
const SLOW_MS = 25_000;
const SHOWN = 5;
const BOX_MAX = 120; // px: the box grows with the text up to this

/**
 * Ask, as a chat window: say what you want, get up to 5 real pop-ups with a reason each. An agent answers in about
 * ten seconds. Until then (and when it cannot answer) the thread shows what the filters and "For you" would pick for
 * those words, so it is never a blank wait. It is not modal: the map stays usable, and it minimises to the bubble
 * without losing the thread. `items` is the public list; `nearPos` is your position if you shared it, and it stays
 * here: it is only used to put the nearest first.
 */
export function AskChat({ items, nearPos, onOpen }: { items: Popup[]; nearPos: [number, number] | null; onOpen: (slug: string) => void }) {
  const qc = useQueryClient();
  const a = useAsk();
  const status = useAskStatus();
  const taste = useTaste();
  const [text, setText] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [refine, setRefine] = useState<Record<number, Refine | null>>({});
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const s = status.data;
  const busy = isAsking(a);
  const last = a.turns.at(-1);
  const summary = useMemo(() => tasteSummary(taste), [taste]);
  const botCheck = !!s?.needs_bot_check && !!s.turnstile_site_key;
  const closed = a.blocked || !!s?.resting || (s ? s.left <= 0 : false);
  const max = s?.max_chars ?? 300;
  // Said again when the chat is opened later in the day, not only right after the answer that hit the limit
  const limitNote = last?.phase === 'failed' && last.message ? null : s?.resting ? ASK_RESTING : s && s.left <= 0 ? askLimited(s.per_visitor ?? ASK_PER_VISITOR) : null;
  const ready = text.trim().length >= 3 && !busy && !closed && (!botCheck || !!token);
  const keyboard = useKeyboardInset(a.open);

  // Looking at the thread now: the dot on the bubble goes. Focus the box when it opens (not on a phone: the keyboard would cover the greeting).
  useEffect(() => { if (a.open) markAskSeen(); }, [a.open, last?.phase]);
  useEffect(() => { if (a.open && !isPhone()) field.current?.focus(); }, [a.open]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);
  // A question that was not accepted comes back to the box
  useEffect(() => { if (a.draft !== null) { setText(a.draft); field.current?.focus(); } }, [a.draft]);
  // Newest at the bottom
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [a.turns.length, last?.phase, a.open]);
  // The box grows with what is typed
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, BOX_MAX)}px`;
  }, [text]);

  // `shown` is what the thread shows; what is sent also carries the question it follows (see composeQuestion)
  const go = (shown: string) => {
    const earlier = last?.phase === 'done' ? last.question : null;
    void ask(qc, { text: shown, send: composeQuestion(shown, earlier, max), taste: summary, nearMe: !!nearPos, token }).finally(() => { setToken(null); setReset(n => n + 1); });
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    go(text);
    setText('');
  };
  // A tap on a suggestion asks at once. When something stops it (a bot check, a limit), it goes into the box instead.
  const send = (q: string) => {
    if (busy || closed || (botCheck && !token)) { setText(q); field.current?.focus(); return; }
    go(q);
  };

  const byId = useMemo(() => new Map(items.map(p => [p.id, p])), [items]);

  const minimise = () => {
    const inside = box.current?.contains(document.activeElement);
    closeAsk();
    if (inside) document.getElementById('ask-fab')?.focus({ preventScroll: true });
  };

  return (
    <section ref={box} className="ca" hidden={!a.open} role="dialog" aria-modal="false" aria-labelledby="ca-title" style={{ '--kb': `${keyboard}px` } as React.CSSProperties}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); minimise(); } }}>
      <header className="ca-head">
        <span className="ca-av" aria-hidden="true"><Icon name="i-bolt" /></span>
        <div><b id="ca-title">Ask Spotted</b><small>Picks from what is on</small></div>
        <span className="spacer" />
        {a.turns.length ? <button type="button" className="btn sm subtle" onClick={() => { clearAsk(); setRefine({}); setText(''); }}>New chat</button> : null}
        <button type="button" className="mp-x" aria-label="Minimise Ask" onClick={minimise}><Icon name="i-down" /></button>
      </header>

      <div className="ca-log" ref={log} role="log" aria-live="polite">
        <div className="ca-m bot">
          <p>Hi! Say what you are after and I will pick from what is on. Add where, when or how much if you like.</p>
          {!a.turns.length && !closed ? (
            <div className="chips ca-quick" role="group" aria-label="Examples">
              {EXAMPLES.map(x => <button key={x} type="button" className="chip" disabled={busy} onClick={() => send(x)}>{x}</button>)}
            </div>
          ) : null}
          <p className="ca-fine"><Icon name="i-info" /><span>Your question is sent to Spotted's AI helper{summary ? ', with a short summary of what you like' : ''}.{nearPos ? ' Your location stays on this device.' : ''}</span></p>
        </div>

        {a.turns.map(t => (
          <Fragment key={t.id}>
            <div className="ca-m me"><p>{t.question}</p></div>
            <BotTurn t={t} latest={t === last} items={items} byId={byId} nearPos={nearPos} now={now} taste={taste}
              by={refine[t.id] ?? null} onRefine={r => setRefine(m => ({ ...m, [t.id]: r }))} onMore={() => send('Something different')} onOpen={onOpen} />
          </Fragment>
        ))}
        {limitNote ? <div className="ca-m bot"><p>{limitNote}</p></div> : null}
      </div>

      <form className="ca-form" noValidate onSubmit={submit}>
        {a.error ? <span className="ferr" id="ca-err" role="alert">{a.error}</span> : null}
        {botCheck && !closed ? <Turnstile onToken={setToken} resetKey={reset} /> : null}
        <div className="ca-row">
          <label htmlFor="ca-q" className="sr">What are you after?</label>
          <textarea id="ca-q" ref={field} className={`input ${a.error ? 'bad' : ''}`} rows={1} maxLength={max} value={text} disabled={closed}
            placeholder={closed ? 'Ask is closed for today' : last ? 'Ask a follow-up' : 'Free near Shoreditch'}
            aria-invalid={!!a.error} aria-describedby={a.error ? 'ca-err' : undefined}
            onChange={e => { setText(e.target.value); clearAskError(); }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <button className="ca-send" disabled={!ready} aria-label={busy ? 'Asking' : 'Send'}>{busy ? <span className="spin" /> : <Icon name="i-up" />}</button>
        </div>
        <span className="small muted num" aria-live="polite">{closed || !s ? '' : `${s.left} question${s.left === 1 ? '' : 's'} left today`}</span>
      </form>
    </section>
  );
}

/** The helper's side of one question: waiting, the answer with quick refinements, or why there is none. */
function BotTurn({ t, latest, items, byId, nearPos, now, taste, by, onRefine, onMore, onOpen }: {
  t: Turn; latest: boolean; items: Popup[]; byId: Map<string, Popup>; nearPos: [number, number] | null; now: number; taste: ReturnType<typeof useTaste>;
  by: Refine | null; onRefine: (r: Refine | null) => void; onMore: () => void; onOpen: (slug: string) => void;
}) {
  const waiting = t.phase === 'sending' || t.phase === 'pending';
  const slow = t.phase === 'pending' && now - t.startedAt > SLOW_MS;
  const shaped = useMemo(() => shapePicks(t.picks, byId, { near: t.near, pos: nearPos, by, now: Date.now(), limit: SHOWN }), [t.picks, t.near, byId, nearPos, by]);
  const nothing = t.phase === 'done' && !t.picks.length;
  // What the filters and For you would pick for those words: shown while waiting, and when there is no answer
  const elsewhere = useMemo(() => (waiting || t.phase === 'failed' || nothing ? meanwhile(items, t.question, taste, Date.now(), SHOWN) : []), [waiting, t.phase, nothing, items, t.question, taste]);
  const refinements = useMemo(() => (['free', 'today', 'weekend', ...(nearPos ? ['near' as const] : [])] as Refine[]), [nearPos]);

  return (
    <div className="ca-m bot">
      {waiting ? (
        <>
          <p className="ca-typing"><span className="ca-dots" aria-hidden="true"><i /><i /><i /></span>{slow ? 'Taking longer than usual. You can keep waiting or minimise this: the list still works.' : 'Looking. This usually takes about ten seconds.'}</p>
          {elsewhere.length ? <><p className="ca-lead">While you wait, what the filters and For you pick for those words:</p><ul className="ask-list">{elsewhere.map(p => <AskRow key={p.id} p={p} onOpen={onOpen} />)}</ul></> : null}
        </>
      ) : null}
      {t.phase === 'failed' && t.message ? <p className="ca-err" role="alert">{t.message}</p> : null}
      {t.phase === 'failed' && elsewhere.length ? <><p className="ca-lead">Still on the list:</p><ul className="ask-list">{elsewhere.map(p => <AskRow key={p.id} p={p} onOpen={onOpen} />)}</ul></> : null}
      {nothing ? <p>{t.note || 'Nothing on Spotted matches that right now. Try other words, or use the filters.'}</p> : null}
      {nothing && elsewhere.length ? <><p className="ca-lead">Still on the list:</p><ul className="ask-list">{elsewhere.map(p => <AskRow key={p.id} p={p} onOpen={onOpen} />)}</ul></> : null}
      {t.phase === 'done' && t.picks.length ? (
        <>
          <p><b>{shaped.rows.length === 1 ? 'One pop-up for you' : `${shaped.rows.length} pop-ups for you`}</b>{by ? <span className="muted"> ({REFINE_LABELS[by].toLowerCase()}, from {shaped.total})</span> : null}</p>
          {t.note && !by ? <p className="small muted">{t.note}</p> : null}
          {shaped.rows.length ? <ul className="ask-list">{shaped.rows.map(r => <AskRow key={r.pick.id} pick={r.pick} p={r.item} metres={r.m} onOpen={onOpen} />)}</ul>
            : <p className="small muted">None of those fit. Show all {shaped.total}, or ask again with a different idea.</p>}
          {latest ? (
            <div className="chips ca-quick" role="group" aria-label="Narrow these down">
              {refinements.map(r => <button key={r} type="button" className="chip" aria-pressed={by === r} onClick={() => onRefine(by === r ? null : r)}>{REFINE_LABELS[r]}</button>)}
              <button type="button" className="chip ai" onClick={onMore}><Icon name="i-bolt" />Something different</button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function AskRow({ pick, p, metres, onOpen }: { pick?: AskPick; p: Popup | null; metres?: number; onOpen: (slug: string) => void }) {
  const slug = p?.slug ?? pick?.slug ?? '';
  const title = p?.title ?? pick?.title ?? '';
  return (
    <li>
      <a className="ask-item" href={appUrl(`/p/${slug}`)} onClick={e => { e.preventDefault(); onOpen(slug); }}>
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

/**
 * How much of the bottom of the page the phone keyboard covers, so the chat can ride above it. 0 when there is no
 * keyboard or the browser does not say.
 */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) { setInset(0); return; }
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, [active]);
  return inset;
}
