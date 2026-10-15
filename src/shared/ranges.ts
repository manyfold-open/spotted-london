// Pop-ups with more than one date range (migration 0027). `start_at` and `end_at` always hold the whole span (the
// first day to the last day), so anything that only asks "is it over" or "could it overlap" keeps working. The list of
// ranges is kept beside them (`popups.date_ranges`, `ranges` in the public JSON) only when there are two or more. Every
// question about "is it on now" or "is it on in this window" goes through the functions here, in the Worker and the browser.

import { DAY, MAX_DURATION } from '../lib/scoring';

/** [start, end] in Unix ms: the first day at 00:00 London and the last day at 23:59. */
export type Range = [number, number];

/** At most this many ranges on one pop-up. A snapshot entry grows by about 30 bytes a range. */
export const MAX_RANGES = 12;
/** The first day to the last day of a pop-up with several ranges. */
export const MAX_SPAN = 365 * DAY;

export interface Dated { start_at: number; end_at: number; ranges?: Range[] | null }

/** All the ranges of a pop-up: the list when it has one, else the single span. */
export function rangesOf(p: Dated): Range[] {
  return p.ranges && p.ranges.length > 1 ? p.ranges : [[p.start_at, p.end_at]];
}

/** True when some range ends after `from` and starts before `to` (a window, the same test as end_at > from AND start_at < to). */
export function overlaps(p: Dated, from: number, to: number): boolean {
  for (const [s, e] of rangesOf(p)) if (e > from && s < to) return true;
  return false;
}

/** True when a range is open at `now`. */
export function openAt(p: Dated, now: number): boolean {
  for (const [s, e] of rangesOf(p)) if (s <= now && e >= now) return true;
  return false;
}

/** The range that is open now, else the next one, else the last (the pop-up is over). */
export function currentOrNext(p: Dated, now: number): Range {
  const all = rangesOf(p);
  return all.find(r => r[1] >= now) ?? all[all.length - 1];
}

/** The range hot() should look at: the one open now or next, so a gap between dates is not "live" and the countdown is to the next date. */
export function activeSpan(p: Dated, now: number): { startAt: number; endAt: number } {
  const [startAt, endAt] = currentOrNext(p, now);
  return { startAt, endAt };
}

/** The ranges that have not ended yet, in order. */
export function upcoming(p: Dated, now: number): Range[] {
  return rangesOf(p).filter(r => r[1] >= now);
}

/** Reads the stored column. Anything that is not a clean list of two or more ranges is read as none. */
export function parseRangesColumn(text: string | null | undefined): Range[] | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v) || v.length < 2) return null;
    const out: Range[] = [];
    for (const r of v) {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) return null;
      out.push([r[0], r[1]]);
    }
    return out;
  } catch { return null; }
}

export interface Normalised { ranges: Range[] | null; start_at: number; end_at: number }
export type RangeProblem = { code: 'dates_invalid' | 'too_long' | 'too_many_ranges' | 'span_too_long'; message: string };

/**
 * Cleans a list a person or an agent gave: sorts it, joins ranges that overlap or touch, and checks the limits.
 * One range left after joining is an ordinary pop-up (`ranges: null`). Returns the span to store in start_at and end_at.
 */
export function normaliseRanges(raw: [number, number][]): Normalised | RangeProblem {
  if (raw.length > MAX_RANGES) return { code: 'too_many_ranges', message: `A pop-up can have at most ${MAX_RANGES} date ranges.` };
  if (!raw.length) return { code: 'dates_invalid', message: 'Give at least one date.' };
  for (const [s, e] of raw) {
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return { code: 'dates_invalid', message: 'Each date range must end after it starts.' };
    if (e - s > MAX_DURATION) return { code: 'too_long', message: `A single date range can run for at most ${MAX_DURATION / DAY} days.` };
  }
  const sorted = raw.map(r => [r[0], r[1]] as Range).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const joined: Range[] = [];
  for (const r of sorted) {
    const last = joined[joined.length - 1];
    // Touching counts as joined: 1 to 3 Nov (ends 23:59) and 4 to 6 Nov (starts 00:00) are one run.
    if (last && r[0] <= last[1] + 60_000) last[1] = Math.max(last[1], r[1]);
    else joined.push(r);
  }
  const start_at = joined[0][0], end_at = joined[joined.length - 1][1];
  if (joined.length > 1 && end_at - start_at > MAX_SPAN) return { code: 'span_too_long', message: `The first and last date must be within ${MAX_SPAN / DAY} days of each other.` };
  if (joined.length === 1 && end_at - start_at > MAX_DURATION) return { code: 'too_long', message: `A pop-up can run for at most ${MAX_DURATION / DAY} days.` };
  return { ranges: joined.length > 1 ? joined : null, start_at, end_at };
}

export const isProblem = (n: Normalised | RangeProblem): n is RangeProblem => 'code' in n;

/** True when two lists of ranges share any time. Used to drop duplicate candidates that only overlap in the span. */
export function rangesTouch(a: Dated, b: Dated): boolean {
  const bs = rangesOf(b);
  return rangesOf(a).some(([s, e]) => bs.some(([s2, e2]) => s < e2 && e > s2));
}
