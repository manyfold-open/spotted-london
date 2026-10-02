import type { Popup, Status } from './api';
import type { IconName } from '../components/Icon';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../../src/shared/categories';

export const CATS: Record<Category, string> = CATEGORY_LABELS;
export const CAT_LIST: Category[] = [...CATEGORIES];
export const catIcon = (c: Category) => `c-${c}` as IconName;

const TZ = 'Europe/London';
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

export const fmtDay = (t: number) => dayFmt.format(t);
/** YYYY-MM-DD in London, for date inputs. */
export const londonDate = (t: number) => dateFmt.format(t);

export function dateRange(p: Pick<Popup, 'start_at' | 'end_at'>): string {
  const a = fmtDay(p.start_at), b = fmtDay(p.end_at);
  return a === b ? a : `${a} to ${b}`;
}

export const isLive = (p: Pick<Popup, 'start_at' | 'end_at'>, now = Date.now()) => p.start_at <= now && p.end_at >= now;
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
