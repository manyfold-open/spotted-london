// Verification, vote weight, trust and ranking rules (SPEC §4).
// Pure functions only, so the same rules run in routes, cron jobs and tests.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The longest an ordinary pop-up may run. Zack raised it from 90 to 180 days on 2026-10-03 so a big exhibition (Renoir and Love, 120 days) fits. Longer ones need an admin (date_kind 'long'). */
export const MAX_DURATION = 180 * DAY;

export type Status =
  | 'pending'
  | 'community'
  | 'verified_community'
  | 'verified_admin'
  | 'hidden'
  | 'removed'
  | 'ended';

export const PUBLIC_STATUSES: Status[] = ['community', 'verified_community', 'verified_admin'];

export interface Voter {
  karma: number;
  createdAt: number;
  emailVerified: boolean;
  status: 'active' | 'shadowbanned' | 'banned' | 'deleted';
}

/** §4.2 base(karma): log-scaled so heavy users can't dominate. */
export function karmaFactor(karma: number): number {
  if (karma < 0) return 0.2;
  return clamp(1 + Math.log10(Math.max(karma, 1)), 0.2, 4);
}

/** §4.2 age factor: brand-new accounts vote, but their votes count for nothing yet. */
export function ageFactor(createdAt: number, now: number): number {
  const age = now - createdAt;
  if (age < DAY) return 0;
  if (age < 7 * DAY) return 0.5;
  return 1;
}

export interface Proof {
  checkedIn?: boolean;
  photo?: boolean;
}

/** §4.2 weight = base(karma) × age × email × proof. Shadowbanned or banned users weigh 0. */
export function voteWeight(v: Voter, now: number, proof: Proof = {}): number {
  if (v.status !== 'active') return 0;
  let w = karmaFactor(v.karma) * ageFactor(v.createdAt, now) * (v.emailVerified ? 1.2 : 1);
  if (proof.checkedIn) w *= 3;
  if (proof.checkedIn && proof.photo) w *= 1.5;
  return round(w, 4);
}

/** §4.3 Wilson score lower bound on weighted votes. */
export function wilson(pos: number, neg: number, z = 1.28): number {
  const n = pos + neg;
  if (n <= 0) return 0;
  const p = pos / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export interface Aggregates {
  status: Status;
  startAt: number;
  endAt: number;
  existPos: number;
  existNeg: number;
  voterCount: number;
  checkinCount: number;
  reportWeight: number;
}

export const VERIFY_CONFIDENCE = 0.75;
export const VERIFY_MIN_WEIGHT = 8;
export const HIDE_CONFIDENCE = 0.3;
export const HIDE_MIN_WEIGHT = 5;
export const DEMOTE_CONFIDENCE = 0.5;
export const HIDE_REPORT_WEIGHT = 5;

/**
 * §4.3 Decide the next status from community signals.
 * Admin decisions (verified_admin, removed) and pending/ended are never changed here.
 */
export function nextStatus(a: Aggregates, now: number): Status {
  if (!['community', 'verified_community', 'hidden'].includes(a.status)) return a.status;

  const n = a.existPos + a.existNeg;
  const c = wilson(a.existPos, a.existNeg);
  const started = a.startAt <= now;
  const evidence = started ? a.checkinCount >= 1 || a.voterCount >= 3 : a.voterCount >= 5;

  if (a.reportWeight >= HIDE_REPORT_WEIGHT) return 'hidden';
  if (c <= HIDE_CONFIDENCE && n >= HIDE_MIN_WEIGHT) return 'hidden';
  if (c >= VERIFY_CONFIDENCE && n >= VERIFY_MIN_WEIGHT && evidence) return 'verified_community';
  if (a.status === 'verified_community' && c < DEMOTE_CONFIDENCE) return 'community';
  if (a.status === 'hidden') return 'community';
  return a.status;
}

export const AUTO_APPROVE_TRUST = 50;

/** §4.4 Uploader trust. The source-link bonus applies to one post only. */
export function trust(u: { karma: number; verifiedPosts: number; badPosts: number }): number {
  return Math.round(u.karma * 0.5 + u.verifiedPosts * 5 - u.badPosts * 15);
}

export function initialStatus(
  u: { role: string; karma: number; verifiedPosts: number; badPosts: number },
  hasSource: boolean,
): Status {
  if (u.role === 'admin' || u.role === 'organizer') return 'verified_admin';
  return trust(u) + (hasSource ? 10 : 0) >= AUTO_APPROVE_TRUST ? 'community' : 'pending';
}

/** §4.6 Hot ranking: live and verified first, then soonest to start. */
export function hot(
  p: { status: Status; qualityPos: number; qualityNeg: number; startAt: number; endAt: number },
  now: number,
): number {
  const q = p.qualityPos - p.qualityNeg;
  const order = Math.log10(Math.max(Math.abs(q), 1)) * Math.sign(q);
  const bonus = p.status === 'verified_admin' ? 2 : p.status === 'verified_community' ? 1 : 0;
  // A long run is always on, so it gets no "live now" lift: it sits below the pop-ups that are on for a short time.
  const live = p.startAt <= now && p.endAt >= now && p.endAt - p.startAt <= MAX_DURATION ? 1.5 : 0;
  const decay = p.startAt > now ? (p.startAt - now) / HOUR / 48 : 0;
  return round(order + bonus + live - decay, 6);
}

/** §4.5 Karma table. */
export const KARMA = {
  postVerified: 10,
  postRemoved: -20,
  voteMatched: 1,
  voteMissed: -2,
  checkin: 2,
  photoUsed: 3,
  reportUpheld: 3,
  reportRejected: -1,
  per10Upvotes: 1,
  upvoteCapPerPost: 20,
  dailyGainCap: 50,
} as const;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
