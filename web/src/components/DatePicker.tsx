import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

// Calendar dates are plain YYYY-MM-DD strings. Maths runs on UTC midnights so time zones and
// clock changes never shift a day.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const toUtc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * 86_400_000);
const dow = (d: string) => (new Date(toUtc(d)).getUTCDay() + 6) % 7; // Monday = 0
const monthOf = (d: string) => d.slice(0, 7);
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return fromUtc(t.getTime()).slice(0, 7); };

const label = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const longLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "Sat 3 Oct", with the year only when it is not this year. */
export const fmtDate = (d: string, today = d) => label.format(toUtc(d)).replace(',', '') + (d.slice(0, 4) === today.slice(0, 4) ? '' : ` ${d.slice(0, 4)}`);

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Label shown above the calendar on phones, and read out by screen readers. */
  title: string;
  labelledBy?: string;
  min?: string;
  today: string;
  /** Shades the days between these, so start and end read as one stay. */
  range?: [string, string];
  className?: string;
}

export function DatePicker({ value, onChange, title, labelledBy, min, today, range, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(value || today));
  const [focus, setFocus] = useState(value || today);
  const btn = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const id = useId();

  const show = () => { const v = value || today; setMonth(monthOf(v)); setFocus(v); setOpen(true); };
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const pick = (d: string) => { onChange(d); close(); };
  const allowed = (d: string) => !min || d >= min;

  // Keep keyboard focus on the active day while the calendar is open.
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [open, focus, month]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (d: string) => { setFocus(d); if (monthOf(d) !== month) setMonth(monthOf(d)); };
  const onGridKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); move(addDays(focus, step[e.key])); }
    else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); move(addDays(focus, e.key === 'PageUp' ? -30 : 30)); }
    else if (e.key === 'Home') { e.preventDefault(); move(addDays(focus, -dow(focus))); }
    else if (e.key === 'End') { e.preventDefault(); move(addDays(focus, 6 - dow(focus))); }
  };

  const first = `${month}-01`;
  const start = addDays(first, -dow(first));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weeks = days[35].startsWith(month) ? 6 : days[28].startsWith(month) ? 5 : 4;
  const [y, m] = month.split('-').map(Number);
  const canPrev = !min || addMonths(month, -1) >= monthOf(min);
  const saturday = addDays(today, (5 - dow(today) + 7) % 7);
  const quick: [string, string][] = [['Today', today], ['Tomorrow', addDays(today, 1)], ['Saturday', saturday]];

  return (
    <div className="datefield">
      <button ref={btn} type="button" className={`input datebtn ${className}`} aria-haspopup="dialog" aria-expanded={open}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}-v` : undefined} onClick={() => (open ? close() : show())}>
        <Icon name="i-clock" /><span id={`${id}-v`}>{value ? fmtDate(value, today) : 'Choose a date'}</span>
        <Icon name="i-down" className="i caret" />
      </button>
      {open ? (
        <>
          <div className="popscrim" onClick={() => close(false)} />
          <div className="calpop" role="dialog" aria-modal="true" aria-label={title}>
            <span className="handle" />
            <div className="calhead">
              <span className="caltitle m-only">{title}</span>
              <b aria-live="polite">{MONTHS[m - 1]} {y}</b>
              <span className="spacer" />
              <button type="button" className="calnav" aria-label="Previous month" disabled={!canPrev} onClick={() => setMonth(addMonths(month, -1))}><Icon name="i-down" className="i prev" /></button>
              <button type="button" className="calnav" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><Icon name="i-down" className="i next" /></button>
            </div>
            <div className="calgrid" role="grid" ref={grid} onKeyDown={onGridKey}>
              <div role="row" className="calrow">{DOW.map(d => <span key={d} role="columnheader" className="caldow" aria-label={d}>{d.slice(0, 2)}</span>)}</div>
              {Array.from({ length: weeks }, (_, w) => (
                <div role="row" className="calrow" key={w}>
                  {days.slice(w * 7, w * 7 + 7).map(d => {
                    const inRange = range && range[0] < range[1] && d >= range[0] && d <= range[1];
                    const cls = ['calday', monthOf(d) !== month && 'out', d === today && 'today', d === value && 'sel'].filter(Boolean).join(' ');
                    const cell = inRange ? ['inrange', d === range![0] && 'rs', d === range![1] && 're'].filter(Boolean).join(' ') : undefined;
                    return (
                      <span role="gridcell" key={d} aria-selected={d === value} className={cell}>
                        <button type="button" className={cls} data-day={d} tabIndex={d === focus ? 0 : -1} disabled={!allowed(d)}
                          aria-label={longLabel.format(toUtc(d))} aria-current={d === today ? 'date' : undefined} onClick={() => pick(d)} onFocus={() => setFocus(d)}>
                          {Number(d.slice(8))}
                        </button>
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="calquick">
              {quick.filter(([, d]) => allowed(d)).map(([l, d]) => <button key={l} type="button" className="chip" aria-pressed={d === value} onClick={() => pick(d)}>{l}</button>)}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
