import { describe, expect, it } from 'vitest';
import { composeQuestion, FOLLOW_UP_CONTEXT, shapePicks, type AskItem } from '../src/shared/ask-chat';

const HOUR = 3_600_000, DAY = 24 * HOUR;
// Wed 30 Sep 2026, 14:00 London (BST)
const NOW = Date.UTC(2026, 8, 30, 13);

const item = (id: string, over: Partial<AskItem> & { lat?: number; lng?: number } = {}): AskItem => ({
  id, price: { type: over.price?.type ?? 'paid' }, start_at: over.start_at ?? NOW - HOUR, end_at: over.end_at ?? NOW + 5 * DAY,
  location: { lat: over.lat ?? 51.52, lng: over.lng ?? -0.08 },
});
const byId = (...items: AskItem[]) => new Map(items.map(i => [i.id, i]));
const opts = { near: false, pos: null, by: null, now: NOW, limit: 5 } as const;

describe('composeQuestion', () => {
  it('sends the first question as it is', () => {
    expect(composeQuestion('  free things  ', null, 300)).toBe('free things');
    expect(composeQuestion('free things', '   ', 300)).toBe('free things');
  });

  it('adds the earlier question to a follow-up, on one line', () => {
    expect(composeQuestion('cheaper', 'something to eat\non Saturday', 300)).toBe('cheaper (Earlier I asked: something to eat on Saturday)');
  });

  it('cuts a long earlier question, and keeps the whole result within the limit', () => {
    const out = composeQuestion('closer to Soho please', 'x'.repeat(400), 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain('x'.repeat(FOLLOW_UP_CONTEXT));
    expect(composeQuestion('y'.repeat(60), 'x'.repeat(400), 100).length).toBeLessThanOrEqual(100);
  });

  it('leaves the earlier question out when there is no room for a useful piece of it', () => {
    expect(composeQuestion('z'.repeat(290), 'something to eat', 300)).toBe('z'.repeat(290));
  });
});

describe('shapePicks', () => {
  const a = item('a', { price: { type: 'free' }, lat: 51.55 }), b = item('b', { lat: 51.52 }), c = item('c', { price: { type: 'free' }, lat: 51.51 });
  const picks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'gone' }];
  const map = byId(a, b, c);

  it('keeps the agent order and a pick that has left the list, and counts them all', () => {
    const out = shapePicks(picks, map, opts);
    expect(out.rows.map(r => r.pick.id)).toEqual(['a', 'b', 'c', 'gone']);
    expect(out.rows[3].item).toBeNull();
    expect(out.total).toBe(4);
  });

  it('puts the nearest first when the request was about where they are, and says how far', () => {
    const out = shapePicks(picks, map, { ...opts, near: true, pos: [51.51, -0.08] });
    expect(out.rows.map(r => r.pick.id)).toEqual(['c', 'b', 'a', 'gone']);
    expect(out.rows[0].m).toBeLessThan(out.rows[1].m!);
    expect(out.rows[3].m).toBeUndefined();
  });

  it('does not reorder without a position', () => {
    expect(shapePicks(picks, map, { ...opts, near: true, pos: null }).rows.map(r => r.pick.id)).toEqual(['a', 'b', 'c', 'gone']);
  });

  it('narrows to free ones, drops a pick it knows nothing about, and still reports the total', () => {
    const out = shapePicks(picks, map, { ...opts, by: 'free' });
    expect(out.rows.map(r => r.pick.id)).toEqual(['a', 'c']);
    expect(out.total).toBe(4);
  });

  it('narrows to what runs today, or this weekend (Fri to Sun)', () => {
    const later = item('later', { start_at: NOW + 3 * DAY, end_at: NOW + 4 * DAY }); // Sat 3 Oct
    const m = byId(b, later);
    const p = [{ id: 'b' }, { id: 'later' }];
    expect(shapePicks(p, m, { ...opts, by: 'today' }).rows.map(r => r.pick.id)).toEqual(['b']);
    expect(shapePicks(p, m, { ...opts, by: 'weekend' }).rows.map(r => r.pick.id)).toEqual(['b', 'later']);
    const ended = byId(item('old', { start_at: NOW - 3 * DAY, end_at: NOW - DAY }));
    expect(shapePicks([{ id: 'old' }], ended, { ...opts, by: 'today' }).rows).toEqual([]);
  });

  it('closest first needs a position and shows at most `limit`', () => {
    const out = shapePicks(picks, map, { ...opts, by: 'near', pos: [51.55, -0.08], limit: 2 });
    expect(out.rows.map(r => r.pick.id)).toEqual(['a', 'b']);
  });
});
