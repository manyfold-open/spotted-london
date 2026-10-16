import { describe, expect, it } from 'vitest';
import { summariseActivation, summariseLive, summarisePeople, summarisePosts, type ActivityRow, type LiveRow } from '../src/lib/contrib';

const row = (user_id: string, kind: ActivityRow['kind'], cur: number, prev = 0): ActivityRow => ({ user_id, kind, cur, prev });

describe('summarisePeople', () => {
  it('counts each person once however many kinds of thing they did', () => {
    const r = summarisePeople([row('a', 'save', 3), row('a', 'vote', 1), row('b', 'save', 1), row('c', 'post', 2)]);
    expect(r.contributors).toBe(3);
    expect(r.by_kind).toEqual({ saves: 2, votes: 1, checkins: 0, reports: 0, posts: 1 });
  });

  it('spreads people by total actions: once, 2 to 5, 6 or more', () => {
    const r = summarisePeople([row('a', 'save', 1), row('b', 'save', 5), row('c', 'save', 3), row('c', 'vote', 3), row('d', 'vote', 6)]);
    expect(r.spread).toEqual({ once: 1, few: 1, many: 2 });
  });

  it('ignores people who only acted in the period before', () => {
    const r = summarisePeople([row('a', 'save', 0, 4), row('b', 'save', 1, 0)]);
    expect(r.contributors).toBe(1);
  });

  it('says who came back, and holds the rate back while the sample is tiny', () => {
    const few = summarisePeople([row('a', 'save', 1, 1), row('b', 'save', 0, 1)]);
    expect(few.repeat).toEqual({ last_period: 2, came_back: 1, rate: null });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const five = summarisePeople(ids.map((id, i) => row(id, 'vote', i < 2 ? 1 : 0, 1)));
    expect(five.repeat).toEqual({ last_period: 5, came_back: 2, rate: 0.4 });
  });

  it('measures how much the busiest 10% did, only with 10 or more people', () => {
    expect(summarisePeople([row('a', 'save', 50), row('b', 'save', 1)]).top_share).toBeNull();
    const rows = [row('top', 'save', 10), ...Array.from({ length: 9 }, (_, i) => row(`p${i}`, 'save', 10 / 9))];
    expect(summarisePeople(rows).top_share).toBeCloseTo(0.5, 5);
  });

  it('handles nobody', () => {
    const r = summarisePeople([]);
    expect(r).toMatchObject({ contributors: 0, spread: { once: 0, few: 0, many: 0 }, top_share: null });
    expect(r.repeat.rate).toBeNull();
  });
});

describe('summariseActivation', () => {
  const H = 3_600_000;
  it('counts accounts that did something and takes the median wait', () => {
    const r = summariseActivation([{ created_at: 0, first: 2 * H }, { created_at: 0, first: 10 * H }, { created_at: 0, first: 4 * H }, { created_at: 0, first: null }]);
    expect(r).toEqual({ new_accounts: 4, acted: 3, median_hours: 4 });
  });
  it('averages the two middle waits and never goes negative', () => {
    const r = summariseActivation([{ created_at: 5 * H, first: 5 * H + H }, { created_at: 5 * H, first: 5 * H + 3 * H }, { created_at: 5 * H, first: H }]);
    expect(r.median_hours).toBe(1);
    expect(summariseActivation([{ created_at: 0, first: 3 * H }, { created_at: 0, first: 4 * H }]).median_hours).toBe(3.5);
  });
  it('has no median with nobody acting', () => {
    expect(summariseActivation([{ created_at: 0, first: null }]).median_hours).toBeNull();
    expect(summariseActivation([])).toEqual({ new_accounts: 0, acted: 0, median_hours: null });
  });
});

describe('summarisePosts', () => {
  it('groups statuses', () => {
    expect(summarisePosts({ pending: 2, community: 3, verified_community: 1, verified_admin: 1, hidden: 1, removed: 2, ended: 4 }))
      .toEqual({ total: 14, waiting: 2, live: 5, verified: 2, turned_down: 3, ended: 4 });
  });
});

describe('summariseLive', () => {
  const live: LiveRow[] = [
    { id: '1', slug: 'one', category: 'food', borough: 'Soho', status: 'community', checked: true, agent: false },
    { id: '2', slug: 'two', category: 'food', borough: 'Soho', status: 'verified_community', checked: true, agent: true },
    { id: '3', slug: 'three', category: 'art', borough: null, status: 'verified_admin', checked: false, agent: true },
  ];
  const saves = new Map([['1', 2], ['2', 1], ['gone', 9]]);

  it('splits people from agents and counts what is vouched for', () => {
    const r = summariseLive(live, saves, new Map([['one', 10], ['three', 4], ['not-live', 99]]));
    expect(r.coverage).toEqual({ live: 3, checked: 2, by_status: { community: 1, verified_community: 1, verified_admin: 1 } });
    expect(r.origin.people).toEqual({ live: 1, saves: 2, opens: 10 });
    expect(r.origin.agents).toEqual({ live: 2, saves: 1, opens: 4 });
  });

  it('lists categories and areas biggest first, leaves out pop-ups with no area, and ignores saves on pop-ups no longer live', () => {
    const r = summariseLive(live, saves, null);
    expect(r.by_category).toEqual([{ key: 'food', live: 2, saves: 3, opens: null }, { key: 'art', live: 1, saves: 0, opens: null }]);
    expect(r.by_area).toEqual([{ key: 'Soho', live: 2, saves: 3, opens: null }]);
    expect(r.origin.people.opens).toBeNull();
  });
});
