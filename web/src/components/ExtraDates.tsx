import { useId } from 'react';
import { Icon } from './Icon';
import { DatePicker, addDays } from './DatePicker';
import { londonDate } from '../lib/format';
import { MAX_RANGES } from '../../../src/shared/ranges';
import type { DateRow } from '../lib/date-rows';

const today = () => londonDate(Date.now());

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
