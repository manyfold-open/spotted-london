import { londonDate, londonTs } from './dates';
import { MAX_RANGES, MAX_SPAN } from '../../../src/shared/ranges';
import { MAX_DURATION } from '../../../src/lib/scoring';

/** One more date range under the first one: a pop-up that runs on separate days (29 Oct and 26 Nov) or periods. */
export interface DateRow { start: string; end: string }


/** The extra rows of a pop-up that already has several ranges (the first one is the Starts and Ends pickers). */
export const rowsOf = (p: { ranges?: [number, number][] }): DateRow[] => (p.ranges ?? []).slice(1).map(([s, e]) => ({ start: londonDate(s), end: londonDate(e) }));

/** The `ranges` to send: null when there are no extra rows, so an edit clears an old list. */
export function rangesPayload(start: string, end: string, rows: DateRow[]): [number, number][] | null {
  if (!rows.length) return null;
  return [[londonTs(start, 0), londonTs(end, 23, 59)], ...rows.map(r => [londonTs(r.start, 0), londonTs(r.end, 23, 59)] as [number, number])];
}

/** The first thing wrong with the list of dates, in words a person can act on. Null when it is fine. */
export function datesProblem(start: string, end: string, rows: DateRow[]): string | null {
  if (!rows.length) return null;
  if (rows.length + 1 > MAX_RANGES) return `A pop-up can have at most ${MAX_RANGES} dates.`;
  let prev = end;
  for (const [i, r] of rows.entries()) {
    if (!r.start || !r.end) return `Pick the start and end of date ${i + 2}, or remove it.`;
    if (r.end < r.start) return `Date ${i + 2} ends before it starts.`;
    if (r.start <= prev) return `Date ${i + 2} must start after date ${i + 1} ends. Dates go in order and do not overlap.`;
    prev = r.end;
  }
  const all = [{ start, end }, ...rows];
  if (all.some(r => Date.parse(r.end) - Date.parse(r.start) > MAX_DURATION)) return 'Each date can run for at most 180 days.';
  if (Date.parse(prev) - Date.parse(start) > MAX_SPAN) return 'The first and the last date must be within a year of each other.';
  return null;
}

