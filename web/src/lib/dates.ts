// Calendar dates and the words for them, with no React or API imports so the tests can run them.
import { currentOrNext, openAt, rangesOf, type Dated } from '../../../src/shared/ranges';

const TZ = 'Europe/London';
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

export const fmtDay = (t: number) => dayFmt.format(t);
/** YYYY-MM-DD in London, for date inputs. */
export const londonDate = (t: number) => dateFmt.format(t);

type Dates = { start_at: number; end_at: number; ranges?: [number, number][]; date_kind?: 'long' | 'open_end' | 'undated' };

const rangeText = ([s, e]: [number, number]) => {
  const a = fmtDay(s), b = fmtDay(e);
  return a === b ? a : `${a} to ${b}`;
};
/** "Thu 29 Oct", "Thu 29 Oct and Thu 26 Nov", "a, b and c". */
const listText = (parts: string[]) => (parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** Every date of a pop-up, in full: for the sheet and for places with room. */
export function dateRange(p: Dates): string {
  // Open dates have stand-in start and end values: never show those as if they were announced.
  if (p.date_kind === 'undated') return 'Dates not announced';
  if (p.date_kind === 'open_end') return `From ${fmtDay(p.start_at)}, no end date announced`;
  return listText(rangesOf(p as Dated).map(rangeText));
}

/**
 * One short line for a card: the date that is on or next, and how many more there are. With several ranges
 * start_at and end_at are the whole span, so they must never be shown as the dates.
 */
export function dateShort(p: Dates, now = Date.now()): string {
  if (p.date_kind || !p.ranges || p.ranges.length < 2) return dateRange(p);
  const left = p.ranges.filter(r => r[1] >= now).length;
  const here = rangeText(currentOrNext(p as Dated, now));
  return left > 1 ? `${here} +${left - 1} more` : here;
}

/** The short label for the tag next to a pop-up whose dates are not a normal short run. */
export const DATE_KIND_LABEL = { long: 'Long run', open_end: 'No end date', undated: 'Dates not announced' } as const;

// With no dates announced the stand-in start is only the day it was added, so it is never "on now".
export const isLive = (p: Dates, now = Date.now()) => p.date_kind !== 'undated' && openAt(p as Dated, now);
/** When the pop-up is next on: the start of the range that is open now or comes next. */
export const nextStart = (p: Dates, now = Date.now()) => currentOrNext(p as Dated, now)[0];
export const startsTomorrow = (p: Dates, now = Date.now()) => nextStart(p, now) > now && londonDate(nextStart(p, now)) === londonDate(now + 86_400_000);

/** London wall-clock date + hour to Unix ms (handles BST). */
export function londonTs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(t).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  return guess - offset(guess - offset(guess));
}

