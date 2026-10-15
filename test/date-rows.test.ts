import { describe, expect, it } from 'vitest';
import { datesProblem, rangesPayload, rowsOf } from '../web/src/lib/date-rows';
import { dateRange, dateShort, isLive, startsTomorrow } from '../web/src/lib/dates';
import { londonTime } from '../src/lib/time';

const day = (m: number, d: number) => londonTime(2026, m, d, 0, 0);
const end = (m: number, d: number) => londonTime(2026, m, d, 23, 59);
const boe = { start_at: day(10, 29), end_at: end(11, 26), ranges: [[day(10, 29), end(10, 29)], [day(11, 26), end(11, 26)]] as [number, number][] };

describe('date rows on the Add and Edit pages', () => {
  it('sends null for no extra rows, so an edit clears an old list', () => {
    expect(rangesPayload('2026-10-29', '2026-10-29', [])).toBeNull();
  });

  it('sends the first range and the extra rows as London days', () => {
    expect(rangesPayload('2026-10-29', '2026-10-29', [{ start: '2026-11-26', end: '2026-11-26' }])).toEqual(boe.ranges);
  });

  it('fills the extra rows from a pop-up that has ranges, and none from one that has not', () => {
    expect(rowsOf(boe)).toEqual([{ start: '2026-11-26', end: '2026-11-26' }]);
    expect(rowsOf({})).toEqual([]);
  });

  it('says what is wrong in plain words', () => {
    const ok = [{ start: '2026-11-26', end: '2026-11-26' }];
    expect(datesProblem('2026-10-29', '2026-10-29', ok)).toBeNull();
    expect(datesProblem('2026-10-29', '2026-10-29', [])).toBeNull();
    expect(datesProblem('2026-10-29', '2026-10-29', [{ start: '', end: '' }])).toMatch(/Pick the start and end of date 2/);
    expect(datesProblem('2026-10-29', '2026-10-29', [{ start: '2026-11-26', end: '2026-11-25' }])).toMatch(/ends before it starts/);
    expect(datesProblem('2026-10-29', '2026-10-31', [{ start: '2026-10-30', end: '2026-11-02' }])).toMatch(/must start after date 1 ends/);
    expect(datesProblem('2026-10-29', '2026-10-29', [{ start: '2027-12-26', end: '2027-12-26' }])).toMatch(/within a year/);
    expect(datesProblem('2026-01-01', '2026-08-01', ok)).toMatch(/at most 180 days/);
    const many = Array.from({ length: 12 }, (_, i) => ({ start: `2026-11-${String(i + 1).padStart(2, '0')}`, end: `2026-11-${String(i + 1).padStart(2, '0')}` }));
    expect(datesProblem('2026-10-29', '2026-10-29', many)).toMatch(/at most 12/);
  });
});

describe('date text', () => {
  it('lists every date in full and one next date on a card', () => {
    expect(dateRange(boe)).toBe('Thu 29 Oct and Thu 26 Nov');
    expect(dateShort(boe, day(10, 1))).toBe('Thu 29 Oct +1 more');
    expect(dateShort(boe, day(11, 5))).toBe('Thu 26 Nov');
    expect(dateShort(boe, day(12, 5))).toBe('Thu 26 Nov');
    const three = { ...boe, ranges: [...boe.ranges, [day(12, 10), end(12, 10)]] as [number, number][], end_at: end(12, 10) };
    expect(dateRange(three)).toBe('Thu 29 Oct, Thu 26 Nov and Thu 10 Dec');
    expect(dateShort({ start_at: day(10, 29), end_at: end(10, 30) }, day(10, 1))).toBe('Thu 29 Oct to Fri 30 Oct');
  });

  it('is live and "tomorrow" by the range, not by the span', () => {
    expect(isLive(boe, day(11, 10))).toBe(false);
    expect(isLive(boe, day(11, 26) + 3_600_000)).toBe(true);
    expect(startsTomorrow(boe, day(11, 25) + 3_600_000)).toBe(true);
    expect(startsTomorrow(boe, day(11, 10))).toBe(false);
  });
});
