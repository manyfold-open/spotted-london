// The Contributions numbers for /admin/insights, read from D1. The maths is in src/lib/contrib.ts.
//
// Cost: no query here has a created_at index, so each reads its whole table once (saves, votes, checkins, reports,
// popups). That is fine at today's size and the result is kept 5 minutes with the rest of Insights. If these tables
// grow past a few hundred thousand rows, move the per-person query into a daily rollup (like health_daily) instead.
// The per-account first-action lookup uses the user_id indexes, so it is one lookup per new account.

import { DAY, PUBLIC_STATUSES } from '../lib/scoring';
import {
  ACTIVITY_KINDS, summariseActivation, summariseLive, summarisePeople, summarisePosts,
  type ActivityKind, type ActivityRow, type LiveRow,
} from '../lib/contrib';
import type { Contributions, InsightDays } from '../shared/insights';

/** Agents and system accounts have an address ending in .invalid; deleted accounts are not people any more. */
const REAL = "u.status != 'deleted' AND u.email NOT LIKE '%.invalid'";
const PUBLIC = PUBLIC_STATUSES.map(() => '?').join(',');

export async function loadContributions(db: D1Database, days: InsightDays, now: number, opens: Map<string, number> | null): Promise<Contributions> {
  const cut = now - days * DAY;       // start of this period
  const since = now - 2 * days * DAY; // start of the one before it

  const [activity, firsts, posts, live, saved] = await Promise.all([
    db.prepare(
      `SELECT a.user_id AS user_id, a.kind AS kind, SUM(a.t > ?) AS cur, SUM(a.t <= ?) AS prev
       FROM (
         SELECT user_id, 'save' AS kind, created_at AS t FROM saves WHERE created_at > ?
         UNION ALL SELECT user_id, 'vote', created_at FROM votes WHERE created_at > ?
         UNION ALL SELECT user_id, 'checkin', created_at FROM checkins WHERE created_at > ?
         UNION ALL SELECT user_id, 'report', created_at FROM reports WHERE created_at > ?
         UNION ALL SELECT created_by, 'post', created_at FROM popups WHERE created_at > ?
       ) a JOIN users u ON u.id = a.user_id
       WHERE ${REAL}
       GROUP BY a.user_id, a.kind`,
    ).bind(cut, cut, since, since, since, since, since).all<ActivityRow>(),

    db.prepare(
      `SELECT u.created_at AS created_at, (
         SELECT MIN(t) FROM (
           SELECT created_at AS t FROM saves WHERE user_id = u.id
           UNION ALL SELECT created_at FROM votes WHERE user_id = u.id
           UNION ALL SELECT created_at FROM checkins WHERE user_id = u.id
           UNION ALL SELECT created_at FROM reports WHERE user_id = u.id
           UNION ALL SELECT created_at FROM popups WHERE created_by = u.id
         )
       ) AS first
       FROM users u WHERE ${REAL} AND u.created_at > ?`,
    ).bind(cut).all<{ created_at: number; first: number | null }>(),

    db.prepare(
      `SELECT p.status AS status, COUNT(*) AS n FROM popups p JOIN users u ON u.id = p.created_by
       WHERE p.created_at > ? AND ${REAL} GROUP BY p.status`,
    ).bind(cut).all<{ status: string; n: number }>(),

    db.prepare(
      `SELECT p.id AS id, p.slug AS slug, p.category AS category, p.borough AS borough, p.status AS status,
              (p.voter_count > 0 OR p.checkin_count > 0) AS checked, (u.email LIKE '%.invalid') AS agent
       FROM popups p JOIN users u ON u.id = p.created_by
       WHERE p.status IN (${PUBLIC}) AND p.end_at > ?`,
    ).bind(...PUBLIC_STATUSES, now).all<{ id: string; slug: string; category: string; borough: string | null; status: string; checked: number; agent: number }>(),

    db.prepare('SELECT popup_id, COUNT(*) AS n FROM saves WHERE created_at > ? GROUP BY popup_id').bind(cut).all<{ popup_id: string; n: number }>(),
  ]);

  const rows = activity.results.filter(r => (ACTIVITY_KINDS as readonly string[]).includes(r.kind as ActivityKind));
  const liveRows: LiveRow[] = live.results.map(r => ({ id: r.id, slug: r.slug, category: r.category, borough: r.borough, status: r.status, checked: !!r.checked, agent: !!r.agent }));
  return {
    ...summarisePeople(rows),
    activation: summariseActivation(firsts.results),
    posts: summarisePosts(Object.fromEntries(posts.results.map(r => [r.status, Number(r.n) || 0]))),
    ...summariseLive(liveRows, new Map(saved.results.map(r => [r.popup_id, Number(r.n) || 0])), opens),
  };
}
