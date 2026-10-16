// The pure maths behind the Contributions panel on /admin/insights. No database here, so test/contrib.test.ts can feed it rows.
// Everything is a count or a share. Nothing says who anyone is: user ids stay inside these functions and never leave them.

import type { Contributions } from '../shared/insights';

export const ACTIVITY_KINDS = ['save', 'vote', 'checkin', 'report', 'post'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** What one person did of one kind: `cur` in the period, `prev` in the period before it. */
export interface ActivityRow { user_id: string; kind: ActivityKind; cur: number; prev: number }

/** Fewer people than this and "the busiest 10%" says nothing. */
const MIN_FOR_SHARE = 10;
/** Fewer people than this and a rate is noise (same rule as visitor retention). */
const MIN_FOR_RATE = 5;

type People = Pick<Contributions, 'contributors' | 'by_kind' | 'spread' | 'top_share' | 'repeat'>;

export function summarisePeople(rows: ActivityRow[]): People {
  const totals = new Map<string, number>();
  const before = new Set<string>();
  const kinds: Record<ActivityKind, Set<string>> = { save: new Set(), vote: new Set(), checkin: new Set(), report: new Set(), post: new Set() };
  for (const r of rows) {
    const cur = Number(r.cur) || 0, prev = Number(r.prev) || 0;
    if (cur > 0) { totals.set(r.user_id, (totals.get(r.user_id) ?? 0) + cur); kinds[r.kind].add(r.user_id); }
    if (prev > 0) before.add(r.user_id);
  }
  const counts = [...totals.values()].sort((a, b) => b - a);
  const all = counts.reduce((a, b) => a + b, 0);
  const top = counts.slice(0, Math.max(1, Math.ceil(counts.length / 10))).reduce((a, b) => a + b, 0);
  const cameBack = [...before].filter(id => totals.has(id)).length;
  return {
    contributors: counts.length,
    by_kind: { saves: kinds.save.size, votes: kinds.vote.size, checkins: kinds.checkin.size, reports: kinds.report.size, posts: kinds.post.size },
    spread: { once: counts.filter(n => n === 1).length, few: counts.filter(n => n >= 2 && n <= 5).length, many: counts.filter(n => n >= 6).length },
    top_share: counts.length >= MIN_FOR_SHARE && all > 0 ? top / all : null,
    repeat: { last_period: before.size, came_back: cameBack, rate: before.size >= MIN_FOR_RATE ? cameBack / before.size : null },
  };
}

/** New accounts, how many did anything at all, and the median wait for the first thing. `first` is null for nothing yet. */
export function summariseActivation(accounts: { created_at: number; first: number | null }[]): Contributions['activation'] {
  const waits = accounts
    .filter(a => a.first !== null)
    .map(a => Math.max(0, (a.first! - a.created_at) / 3_600_000))
    .sort((a, b) => a - b);
  const mid = Math.floor(waits.length / 2);
  const median = waits.length === 0 ? null : waits.length % 2 ? waits[mid]! : (waits[mid - 1]! + waits[mid]!) / 2;
  return { new_accounts: accounts.length, acted: waits.length, median_hours: median === null ? null : Math.round(median * 10) / 10 };
}

/** People's posts made in the period, by where they are now. */
export function summarisePosts(byStatus: Record<string, number>): Contributions['posts'] {
  const n = (...s: string[]) => s.reduce((a, k) => a + (byStatus[k] ?? 0), 0);
  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    waiting: n('pending'),
    live: n('community', 'verified_community', 'verified_admin'),
    verified: n('verified_community', 'verified_admin'),
    turned_down: n('hidden', 'removed'),
    ended: n('ended'),
  };
}

/** A pop-up that is public and not over yet. */
export interface LiveRow { id: string; slug: string; category: string; borough: string | null; status: string; checked: boolean; agent: boolean }

type Supply = Contributions['by_category'][number];

export function summariseLive(live: LiveRow[], saves: Map<string, number>, opens: Map<string, number> | null): Pick<Contributions, 'coverage' | 'origin' | 'by_category' | 'by_area'> {
  const origin = { people: { live: 0, saves: 0, opens: opens ? 0 : null as number | null }, agents: { live: 0, saves: 0, opens: opens ? 0 : null as number | null } };
  const cats = new Map<string, Supply>();
  const areas = new Map<string, Supply>();
  let checked = 0;
  const by_status = { community: 0, verified_community: 0, verified_admin: 0 };
  const bump = (m: Map<string, Supply>, key: string, live: number, s: number, o: number) => {
    const cur = m.get(key) ?? { key, live: 0, saves: 0, opens: opens ? 0 : null };
    cur.live += live; cur.saves += s;
    if (cur.opens !== null) cur.opens += o;
    m.set(key, cur);
  };
  for (const p of live) {
    const s = saves.get(p.id) ?? 0, o = opens?.get(p.slug) ?? 0;
    const side = p.agent ? origin.agents : origin.people;
    side.live++; side.saves += s;
    if (side.opens !== null) side.opens += o;
    if (p.checked) checked++;
    if (p.status in by_status) by_status[p.status as keyof typeof by_status]++;
    bump(cats, p.category, 1, s, o);
    if (p.borough) bump(areas, p.borough, 1, s, o);
  }
  const rank = (a: Supply, b: Supply) => b.live - a.live || b.saves - a.saves || a.key.localeCompare(b.key);
  return {
    coverage: { live: live.length, checked, by_status },
    origin,
    by_category: [...cats.values()].sort(rank),
    by_area: [...areas.values()].sort(rank).slice(0, 8),
  };
}
