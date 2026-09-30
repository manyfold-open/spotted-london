// Europe/London calendar helpers. Workers run in UTC, but "today" and
// "this weekend" mean London days, including across BST changes.

import { DAY } from './scoring';

const TZ = 'Europe/London';
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface LondonParts { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number }

export function londonParts(ts: number): LondonParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ts))) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, dow: WEEKDAYS.indexOf(p.weekday) };
}

/** Offset of London from UTC at `ts`, in ms (0 in winter, +1h in summer). */
function offsetAt(ts: number): number {
  const p = londonParts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ts / 1000) * 1000;
}

/** Unix ms for a London wall-clock time. */
export function londonTime(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** Parses 'YYYY-MM-DD' (optionally with 'THH:MM') as London time. */
export function parseLondonDate(s: string, hh = 0, mm = 0): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  return londonTime(+m[1], +m[2], +m[3], m[4] ? +m[4] : hh, m[5] ? +m[5] : mm);
}

export function londonDateString(ts: number): string {
  const p = londonParts(ts);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function addDays(p: LondonParts, n: number) {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export type When = 'today' | 'weekend' | 'week' | 'all';

/** Time window [from, to) for the list filters (SPEC §3.1). */
export function windowFor(when: When, now: number): { from: number; to: number } {
  const p = londonParts(now);
  const day = (n: number) => { const q = addDays(p, n); return londonTime(q.y, q.m, q.d); };
  switch (when) {
    case 'today': return { from: now, to: day(1) };
    case 'week': return { from: now, to: day(7) };
    case 'weekend': {
      // Friday 00:00 to Monday 00:00. On Fri, Sat or Sun this is the current weekend.
      const toFri = p.dow === 5 ? 0 : p.dow === 6 ? -1 : p.dow === 0 ? -2 : 5 - p.dow;
      return { from: Math.max(now, day(toFri)), to: day(toFri + 3) };
    }
    default: return { from: now, to: Number.MAX_SAFE_INTEGER };
  }
}

export const MAX_DURATION = 90 * DAY;
