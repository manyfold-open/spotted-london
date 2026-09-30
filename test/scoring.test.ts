import { describe, expect, it } from 'vitest';
import { ageFactor, DAY, HOUR, hot, initialStatus, karmaFactor, nextStatus, trust, voteWeight, wilson, type Aggregates } from '../src/lib/scoring';

const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London

describe('vote weight (SPEC 4.2)', () => {
  it('scales karma logarithmically and caps at 4', () => {
    expect(karmaFactor(0)).toBe(1);
    expect(karmaFactor(10)).toBeCloseTo(2);
    expect(karmaFactor(100)).toBeCloseTo(3);
    expect(karmaFactor(1_000_000)).toBe(4);
    expect(karmaFactor(-5)).toBe(0.2);
  });

  it('gives new accounts no weight for a day and half weight for a week', () => {
    expect(ageFactor(NOW - 12 * HOUR, NOW)).toBe(0);
    expect(ageFactor(NOW - 3 * DAY, NOW)).toBe(0.5);
    expect(ageFactor(NOW - 30 * DAY, NOW)).toBe(1);
  });

  it('combines karma, age, email and proof', () => {
    const v = { karma: 58, createdAt: NOW - 31 * DAY, emailVerified: true, status: 'active' as const };
    expect(voteWeight(v, NOW)).toBeCloseTo((1 + Math.log10(58)) * 1.2, 3);
    expect(voteWeight(v, NOW, { checkedIn: true })).toBeCloseTo((1 + Math.log10(58)) * 1.2 * 3, 3);
    expect(voteWeight(v, NOW, { checkedIn: true, photo: true })).toBeCloseTo((1 + Math.log10(58)) * 1.2 * 4.5, 3);
    expect(voteWeight({ ...v, status: 'shadowbanned' }, NOW)).toBe(0);
  });
});

describe('wilson lower bound', () => {
  it('is 0 without votes and rewards consistent agreement over raw volume', () => {
    expect(wilson(0, 0)).toBe(0);
    expect(wilson(10, 0)).toBeGreaterThan(wilson(100, 90));
    expect(wilson(10, 0)).toBeLessThan(1);
  });
});

describe('status transitions (SPEC 4.3)', () => {
  const base: Aggregates = {
    status: 'community', startAt: NOW + 2 * DAY, endAt: NOW + 3 * DAY,
    existPos: 7.5, existNeg: 0.8, voterCount: 4, checkinCount: 0, reportWeight: 0,
  };

  it('keeps a promising pop-up in community until the evidence bar is met', () => {
    expect(wilson(7.5, 0.8)).toBeLessThan(0.75);
    expect(nextStatus(base, NOW)).toBe('community');
  });

  it('verifies once confidence, weight and voter count all pass', () => {
    const w = (1 + Math.log10(58)) * 1.2;
    expect(nextStatus({ ...base, existPos: 7.5 + w, voterCount: 5 }, NOW)).toBe('verified_community');
  });

  it('needs 5 voters before start, but a single check-in once live', () => {
    const strong = { ...base, existPos: 20, existNeg: 0, voterCount: 4 };
    expect(nextStatus(strong, NOW)).toBe('community');
    expect(nextStatus({ ...strong, startAt: NOW - HOUR, voterCount: 1, checkinCount: 1 }, NOW)).toBe('verified_community');
  });

  it('hides on low confidence or heavy reports, and never touches admin decisions', () => {
    expect(nextStatus({ ...base, existPos: 1, existNeg: 6 }, NOW)).toBe('hidden');
    expect(nextStatus({ ...base, reportWeight: 5 }, NOW)).toBe('hidden');
    expect(nextStatus({ ...base, status: 'verified_admin', existPos: 0, existNeg: 50 }, NOW)).toBe('verified_admin');
    expect(nextStatus({ ...base, status: 'pending', existPos: 50 }, NOW)).toBe('pending');
  });

  it('demotes community-verified posts that lose support, and restores hidden ones that regain it', () => {
    expect(nextStatus({ ...base, status: 'verified_community', existPos: 6, existNeg: 4 }, NOW)).toBe('community');
    expect(nextStatus({ ...base, status: 'hidden', existPos: 4, existNeg: 1 }, NOW)).toBe('community');
  });
});

describe('trust and initial status (SPEC 4.4)', () => {
  const u = { role: 'user', karma: 58, verifiedPosts: 3, badPosts: 0 };
  it('lets a source link push a trusted member past review', () => {
    expect(trust(u)).toBe(44);
    expect(initialStatus(u, false)).toBe('pending');
    expect(initialStatus(u, true)).toBe('community');
  });
  it('penalises removed posts and trusts admins and organisers', () => {
    expect(trust({ ...u, badPosts: 1 })).toBe(29);
    expect(initialStatus({ ...u, role: 'organizer' }, false)).toBe('verified_admin');
  });
});

describe('hot ranking (SPEC 4.6)', () => {
  it('puts live verified pop-ups above ones starting in a few days', () => {
    const live = hot({ status: 'verified_admin', qualityPos: 50, qualityNeg: 2, startAt: NOW - DAY, endAt: NOW + DAY }, NOW);
    const later = hot({ status: 'community', qualityPos: 50, qualityNeg: 2, startAt: NOW + 3 * DAY, endAt: NOW + 4 * DAY }, NOW);
    expect(live).toBeGreaterThan(later);
  });
});
