import { useId } from 'react';
import { Icon } from './Icon';
import { DatePicker, addDays } from './DatePicker';
import { londonDate, londonTs } from '../lib/format';
import { MAX_RANGES, MAX_SPAN } from '../../../src/shared/ranges';
import { MAX_DURATION } from '../../../src/lib/scoring';
import type { Popup } from '../lib/api';

/** One more date range under the first one: a pop-up that runs on separate days (29 Oct and 26 Nov) or periods. */
export interface DateRow { start: string; end: string }

const today = () => londonDate(Date.now());

/** The extra rows of a pop-up that already has several ranges (the first one is the Starts and Ends pickers). */
export const rowsOf = (p: Pick<Popup, 'ranges'>): DateRow[] => (p.ranges ?? []).slice(1).map(([s, e]) => ({ start: londonDate(s), end: londonDate(e) }));

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

/**
 * "Add another date" under the Starts and Ends pickers. Each row is one more range, in order. Rows start a week after the
 * range before, because a pop-up usually repeats on a regular gap, and the person edits from there.
 */
export function ExtraDates({ firstEnd, rows, onChange, error }: { firstEnd: string; rows: DateRow[]; onChange: (rows: DateRow[]) => void; error?: string | null }) {
  const id = useId();
  const set = (i: number, patch: Partial<DateRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => {
    const prev = rows.length ? rows[rows.length - 1].end : firstEnd;
    const s = addDays(prev, 7);
    onChange([...rows, { start: s, end: s }]);
  };
  return (
    <div className="field" style={{ gap: 10 }}>
      {rows.map((r, i) => {
        const min = addDays(i === 0 ? firstEnd : rows[i - 1].end, 1);
        return (
          <div key={i} className="extradate">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="lbl">Date {i + 2}</span>
              <button type="button" className="btn sm subtle" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove date ${i + 2}`}><Icon name="i-x" />Remove</button>
            </div>
            <div className="two">
              <div className="field"><span className="lbl" id={`${id}-s${i}`}>Starts</span>
                <DatePicker title={`Date ${i + 2} starts`} labelledBy={`${id}-s${i}`} value={r.start} today={today()} min={min} range={[r.start, r.end]}
                  onChange={v => set(i, { start: v, ...(r.end < v ? { end: v } : {}) })} /></div>
              <div className="field"><span className="lbl" id={`${id}-e${i}`}>Ends</span>
                <DatePicker title={`Date ${i + 2} ends`} labelledBy={`${id}-e${i}`} value={r.end} today={today()} min={r.start} range={[r.start, r.end]}
                  onChange={v => set(i, { end: v })} /></div>
            </div>
          </div>
        );
      })}
      {rows.length + 1 < MAX_RANGES ? <button type="button" className="btn sm subtle" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="i-plus" />Add another date</button> : null}
      {rows.length ? <span className="hint">For a pop-up that is on again later, such as 29 Oct and 26 Nov. It shows as open only on these dates.</span> : null}
      {error ? <span className="ferr" role="alert">{error}</span> : null}
    </div>
  );
}
