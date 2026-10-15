import { describe, expect, it } from 'vitest';
import { currentOrNext, isProblem, MAX_RANGES, normaliseRanges, openAt, overlaps, parseRangesColumn, rangesOf, rangesTouch, upcoming } from '../src/shared/ranges';
import { londonTime } from '../src/lib/time';

const day = (m: number, d: number) => londonTime(2026, m, d, 0, 0);
const end = (m: number, d: number) => londonTime(2026, m, d, 23, 59);
// 29 Oct and 26 Nov: the Bank of England tours
const boe = { start_at: day(10, 29), end_at: end(11, 26), ranges: [[day(10, 29), end(10, 29)], [day(11, 26), end(11, 26)]] as [number, number][] };

describe('ranges', () => {
  it('an ordinary pop-up is one range', () => {
    const p = { start_at: day(10, 1), end_at: end(10, 3) };
    expect(rangesOf(p)).toEqual([[p.start_at, p.end_at]]);
    expect(rangesOf({ ...p, ranges: null })).toEqual([[p.start_at, p.end_at]]);
  });

  it('is not open or in a window during the gap', () => {
    const gap = day(11, 10);
    expect(openAt(boe, gap)).toBe(false);
    expect(overlaps(boe, gap, gap + 7 * 86_400_000)).toBe(false);
    expect(openAt(boe, day(10, 29) + 3_600_000)).toBe(true);
    expect(openAt(boe, day(11, 26) + 3_600_000)).toBe(true);
    expect(overlaps(boe, day(11, 20), day(11, 27))).toBe(true);
  });

  it('a weekend window sees a later range even if the first one ends before it', () => {
    const p = { start_at: day(10, 15), end_at: end(10, 17), ranges: [[day(10, 15), end(10, 15)], [day(10, 17), end(10, 17)]] as [number, number][] };
    // asked on Wed 14 Oct, the weekend window starts Fri 16
    expect(overlaps(p, day(10, 16), day(10, 19))).toBe(true);
  });

  it('currentOrNext moves on after a range ends and stays on the last one', () => {
    expect(currentOrNext(boe, day(10, 1))).toEqual(boe.ranges[0]);
    expect(currentOrNext(boe, day(10, 29) + 1000)).toEqual(boe.ranges[0]);
    expect(currentOrNext(boe, day(11, 5))).toEqual(boe.ranges[1]);
    expect(currentOrNext(boe, day(12, 5))).toEqual(boe.ranges[1]);
    expect(upcoming(boe, day(11, 5))).toEqual([boe.ranges[1]]);
  });

  it('normalise sorts, joins touching ranges, and returns the span', () => {
    const r = normaliseRanges([[day(11, 26), end(11, 26)], [day(10, 29), end(10, 29)]]);
    expect(isProblem(r)).toBe(false);
    if (!isProblem(r)) expect(r).toEqual({ ranges: boe.ranges, start_at: boe.start_at, end_at: boe.end_at });
    // 1 to 3 Nov and 4 to 6 Nov are one run, so it is an ordinary pop-up again
    const one = normaliseRanges([[day(11, 1), end(11, 3)], [day(11, 4), end(11, 6)]]);
    expect(one).toEqual({ ranges: null, start_at: day(11, 1), end_at: end(11, 6) });
    // overlapping
    expect(normaliseRanges([[day(11, 1), end(11, 5)], [day(11, 3), end(11, 9)]])).toEqual({ ranges: null, start_at: day(11, 1), end_at: end(11, 9) });
  });

  it('normalise refuses bad lists', () => {
    expect(normaliseRanges([])).toMatchObject({ code: 'dates_invalid' });
    expect(normaliseRanges([[day(11, 5), day(11, 5)]])).toMatchObject({ code: 'dates_invalid' });
    expect(normaliseRanges(Array.from({ length: MAX_RANGES + 1 }, (_, i) => [day(1, 1) + i * 5 * 86_400_000, day(1, 1) + i * 5 * 86_400_000 + 3_600_000] as [number, number]))).toMatchObject({ code: 'too_many_ranges' });
    expect(normaliseRanges([[day(1, 1), end(1, 2)], [day(1, 1) + 400 * 86_400_000, day(1, 1) + 401 * 86_400_000]])).toMatchObject({ code: 'span_too_long' });
    expect(normaliseRanges([[day(1, 1), day(1, 1) + 200 * 86_400_000], [day(12, 1), end(12, 2)]])).toMatchObject({ code: 'too_long' });
  });

  it('reads the stored column defensively', () => {
    expect(parseRangesColumn(null)).toBeNull();
    expect(parseRangesColumn('nope')).toBeNull();
    expect(parseRangesColumn('[[1,2]]')).toBeNull();
    expect(parseRangesColumn('[[1,2],[3,"x"]]')).toBeNull();
    expect(parseRangesColumn('[[1,2],[3,4]]')).toEqual([[1, 2], [3, 4]]);
  });

  it('rangesTouch looks at the ranges, not only the span', () => {
    const inGap = { start_at: day(11, 5), end_at: end(11, 6) };
    expect(rangesTouch(boe, inGap)).toBe(false);
    expect(rangesTouch(boe, { start_at: day(10, 29), end_at: end(10, 29) })).toBe(true);
  });
});
