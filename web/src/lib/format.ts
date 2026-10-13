import type { Popup, Status } from './api';
import type { IconName } from '../components/Icon';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../../src/shared/categories';

export const CATS: Record<Category, string> = CATEGORY_LABELS;
export const CAT_LIST: Category[] = [...CATEGORIES];
export const catIcon = (c: Category): IconName => `c-${c}`;

const TZ = 'Europe/London';
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

export const fmtDay = (t: number) => dayFmt.format(t);
/** YYYY-MM-DD in London, for date inputs. */
export const londonDate = (t: number) => dateFmt.format(t);

export function dateRange(p: Pick<Popup, 'start_at' | 'end_at'> & { date_kind?: Popup['date_kind'] }): string {
  // Open dates have stand-in start and end values: never show those as if they were announced.
  if (p.date_kind === 'undated') return 'Dates not announced';
  if (p.date_kind === 'open_end') return `From ${fmtDay(p.start_at)}, no end date announced`;
  const a = fmtDay(p.start_at), b = fmtDay(p.end_at);
  return a === b ? a : `${a} to ${b}`;
}

/** The short label for the tag next to a pop-up whose dates are not a normal short run. */
export const DATE_KIND_LABEL = { long: 'Long run', open_end: 'No end date', undated: 'Dates not announced' } as const;

// With no dates announced the stand-in start is only the day it was added, so it is never "on now".
export const isLive = (p: Pick<Popup, 'start_at' | 'end_at'> & { date_kind?: Popup['date_kind'] }, now = Date.now()) => p.date_kind !== 'undated' && p.start_at <= now && p.end_at >= now;
export const startsTomorrow = (p: Pick<Popup, 'start_at'>, now = Date.now()) =>
  londonDate(p.start_at) === londonDate(now + 86_400_000);

export const PUBLIC: Status[] = ['community', 'verified_community', 'verified_admin'];

export function meterClass(c: number) {
  return c < 0.4 ? 'low' : c < 0.75 ? 'mid' : '';
}

export function distance(m?: number) {
  if (m === undefined) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function initials(name: string | null | undefined, email?: string) {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

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

/** Loose check, the server has the final say. */
export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
