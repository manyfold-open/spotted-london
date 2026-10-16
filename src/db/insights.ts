// Numbers for the Insights page (/admin/insights). Two sources:
//  - D1: counts of accounts and actions (people who signed in, saves, votes...). Counts only, never who.
//  - Workers Analytics Engine: the anonymous events the browser sends (src/lib/events.ts), read back through its SQL API.
// Both are cached in the Worker, because the page is the only reader and every read costs quota.

import type { Bindings } from '../types';
import { londonDateString } from '../lib/time';
import { DAY, PUBLIC_STATUSES } from '../lib/scoring';
import { snapshotItems } from './snapshot';
import { loadContributions } from './contributions';
import type { Accounts, EventsResult, Insights, InsightDays } from '../shared/insights';

export { INSIGHT_DAYS } from '../shared/insights';
export type { Insights, InsightDays } from '../shared/insights';

export const INSIGHTS_TTL = 5 * 60_000;
const DATASET = 'spotted_events';

interface Count { n: number }

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/* ---------- accounts, from D1 ---------- */

async function loadAccounts(db: D1Database, days: InsightDays, now: number): Promise<Accounts> {
  const since = now - days * DAY;
  const real = "status != 'deleted' AND email NOT LIKE '%.invalid'";
  const one = async (sql: string, ...bind: unknown[]) => num((await db.prepare(sql).bind(...bind).first<Count>())?.n);
  const [total, joined, saves, votes, checkins, reports, added, asks, top] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM users WHERE ${real}`),
    db.prepare(`SELECT created_at FROM users WHERE ${real} AND created_at > ?`).bind(since).all<{ created_at: number }>(),
    one('SELECT COUNT(*) AS n FROM saves WHERE created_at > ?', since),
    one('SELECT COUNT(*) AS n FROM votes WHERE created_at > ?', since),
    one('SELECT COUNT(*) AS n FROM checkins WHERE created_at > ?', since),
    one('SELECT COUNT(*) AS n FROM reports WHERE created_at > ?', since),
    // people's posts only: agent drafts are counted on the Agents page
    one("SELECT COUNT(*) AS n FROM popups WHERE created_at > ? AND created_by IN (SELECT id FROM users WHERE email NOT LIKE '%.invalid')", since),
    one('SELECT COUNT(*) AS n FROM asks WHERE asked_at > ?', since),
    db.prepare(
      `SELECT p.slug, p.title, COUNT(*) AS n FROM saves s JOIN popups p ON p.id = s.popup_id
       WHERE p.status IN (${PUBLIC_STATUSES.map(() => '?').join(',')}) AND p.end_at > ?
       GROUP BY s.popup_id ORDER BY n DESC LIMIT 8`,
    ).bind(...PUBLIC_STATUSES, now).all<{ slug: string; title: string; n: number }>(),
  ]);
  const perDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) perDay.set(londonDateString(now - i * DAY), 0);
  for (const r of joined.results) {
    const d = londonDateString(r.created_at);
    if (perDay.has(d)) perDay.set(d, perDay.get(d)! + 1);
  }
  return {
    total,
    new_in_period: joined.results.length,
    per_day: [...perDay].map(([day, n]) => ({ day, n })),
    actions: { saves, votes, checkins, reports, popups_added: added, asks },
    most_saved: top.results.map(r => ({ slug: r.slug, title: r.title, saves: num(r.n) })),
  };
}

/* ---------- events, from Analytics Engine ---------- */

type Row = Record<string, unknown>;

async function sql(env: Bindings, query: string): Promise<Row[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: query,
  });
  if (!res.ok) throw new Error(`Analytics Engine answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the API token)' : ''}`);
  return ((await res.json()) as { data?: Row[] }).data ?? [];
}

/** Every day in the window, so a quiet day shows as zero instead of a gap. UTC days, like Analytics Engine. */
function utcDays(days: number, now: number): string[] {
  return Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10));
}

async function loadEvents(env: Bindings, days: InsightDays, now: number): Promise<EventsResult> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return { status: 'not_configured', message: 'Add the two secrets below to read the numbers back.' };
  }
  const win = (d: number) => `timestamp > NOW() - INTERVAL '${d}' DAY`;
  const from = (where: string, tail = '') => `FROM ${DATASET} WHERE ${win(days)} ${where ? `AND ${where}` : ''} ${tail}`;
  const q = (select: string, where: string, tail = '') => sql(env, `SELECT ${select} ${from(where, tail)} FORMAT JSON`);
  const W = 'sum(_sample_interval)';
  try {
    const [daily, byEvent, visitors, signedIn, visits, openSlug, saveSlug, openCat, saveCat, filters, refs, pages, countries, devices, u7, p7, u14] = await Promise.all([
      q(`toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, uniq(index1) AS visitors, ${W} AS views`, "blob1 = 'view'", 'GROUP BY day ORDER BY day'),
      q(`blob1 AS name, ${W} AS n, uniq(index1) AS people`, '', 'GROUP BY name'),
      q('uniq(index1) AS n', ''),
      q('uniq(index1) AS n', 'double1 = 1'),
      q(`${W} AS n`, "blob1 = 'view' AND double2 = 1"),
      q(`blob3 AS k, ${W} AS n`, "blob1 = 'popup_open' AND blob3 != ''", 'GROUP BY k ORDER BY n DESC LIMIT 12'),
      q(`blob3 AS k, ${W} AS n`, "blob1 = 'save' AND double2 = 1 AND blob3 != ''", 'GROUP BY k ORDER BY n DESC LIMIT 30'),
      q(`blob4 AS k, ${W} AS n`, "blob1 = 'popup_open' AND blob4 != ''", 'GROUP BY k'),
      q(`blob4 AS k, ${W} AS n`, "blob1 = 'save' AND double2 = 1 AND blob4 != ''", 'GROUP BY k'),
      q(`blob4 AS k, ${W} AS n`, "blob1 = 'filter'", 'GROUP BY k ORDER BY n DESC LIMIT 12'),
      q(`blob5 AS k, ${W} AS n`, "blob1 = 'view' AND double2 = 1", 'GROUP BY k ORDER BY n DESC LIMIT 10'),
      q(`blob2 AS k, ${W} AS n`, "blob1 = 'view'", 'GROUP BY k ORDER BY n DESC LIMIT 10'),
      q(`blob7 AS k, ${W} AS n`, "blob1 = 'view' AND double2 = 1 AND blob7 != ''", 'GROUP BY k ORDER BY n DESC LIMIT 8'),
      q(`blob6 AS k, ${W} AS n`, "blob1 = 'view' AND double2 = 1", 'GROUP BY k'),
      sql(env, `SELECT uniq(index1) AS n FROM ${DATASET} WHERE ${win(7)} FORMAT JSON`),
      sql(env, `SELECT uniq(index1) AS n FROM ${DATASET} WHERE timestamp <= NOW() - INTERVAL '7' DAY AND timestamp > NOW() - INTERVAL '14' DAY FORMAT JSON`),
      sql(env, `SELECT uniq(index1) AS n FROM ${DATASET} WHERE ${win(14)} FORMAT JSON`),
    ]);

    const byDay = new Map(daily.map(r => [String(r.day).slice(0, 10), r]));
    const series = utcDays(days, now).map(day => ({ day, visitors: num(byDay.get(day)?.visitors), views: num(byDay.get(day)?.views) }));

    const titles = new Map((await snapshotItems(env.DB, now)).map(i => [i.slug, i.title]));
    const saves = new Map(saveSlug.map(r => [String(r.k), num(r.n)]));
    const top_popups = openSlug.slice(0, 10).map(r => ({ slug: String(r.k), title: titles.get(String(r.k)) ?? String(r.k), opens: num(r.n), saves: saves.get(String(r.k)) ?? 0 }));

    const catSaves = new Map(saveCat.map(r => [String(r.k), num(r.n)]));
    const keys = new Set([...openCat.map(r => String(r.k)), ...catSaves.keys()]);
    const opens = new Map(openCat.map(r => [String(r.k), num(r.n)]));
    const categories = [...keys].map(key => ({ key, opens: opens.get(key) ?? 0, saves: catSaves.get(key) ?? 0 })).sort((a, b) => b.opens + b.saves - (a.opens + a.saves));

    const last = num(p7[0]?.n);
    const came = Math.max(0, Math.min(last, num(u7[0]?.n), num(u7[0]?.n) + last - num(u14[0]?.n)));
    const dev = new Map(devices.map(r => [String(r.k), num(r.n)]));

    return {
      status: 'ok',
      visitors: num(visitors[0]?.n),
      signed_in_visitors: num(signedIn[0]?.n),
      visits: num(visits[0]?.n),
      views: series.reduce((a, d) => a + d.views, 0),
      daily: series,
      retention: { last_week: last, came_back: came, rate: last >= 5 ? came / last : null },
      funnel: Object.fromEntries(byEvent.map(r => [String(r.name), { n: num(r.n), people: num(r.people) }])),
      top_popups,
      categories,
      filters: filters.map(r => ({ key: String(r.k), n: num(r.n) })),
      referrers: refs.map(r => ({ host: String(r.k), n: num(r.n) })),
      pages: pages.map(r => ({ route: String(r.k), n: num(r.n) })),
      countries: countries.map(r => ({ code: String(r.k), n: num(r.n) })),
      devices: { mobile: dev.get('m') ?? 0, desktop: dev.get('d') ?? 0 },
    };
  } catch (e) {
    console.error('insights events failed', e);
    return { status: 'error', message: e instanceof Error ? e.message : 'Could not read the events.' };
  }
}

/* ---------- both, cached ---------- */

const cache = new Map<number, { at: number; value: Insights }>();
export const clearInsights = () => cache.clear();

/** Opens per pop-up slug over the period, to put next to what people save. Null when visitor numbers are not set up or could not be read. */
async function loadOpens(env: Bindings, days: InsightDays): Promise<Map<string, number> | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  try {
    const rows = await sql(env, `SELECT blob3 AS k, sum(_sample_interval) AS n FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob1 = 'popup_open' AND blob3 != '' GROUP BY k ORDER BY n DESC LIMIT 2000 FORMAT JSON`);
    return new Map(rows.map(r => [String(r.k), num(r.n)]));
  } catch (e) {
    console.error('insights opens failed', e);
    return null;
  }
}

export async function insights(env: Bindings, days: InsightDays, now: number, fresh = false): Promise<Insights> {
  const hit = cache.get(days);
  if (!fresh && hit && now >= hit.at && now - hit.at < INSIGHTS_TTL) return hit.value;
  const [accounts, events, contributions] = await Promise.all([
    loadAccounts(env.DB, days, now),
    loadEvents(env, days, now),
    // A failure here must not take the rest of the page down
    loadOpens(env, days).then(opens => loadContributions(env.DB, days, now, opens)).catch((e): null => { console.error('insights contributions failed', e); return null; }),
  ]);
  const value: Insights = { days, updated_at: now, accounts, events, contributions };
  // A failed read is not kept, so the next visit tries again at once
  if (events.status !== 'error') cache.set(days, { at: now, value });
  return value;
}
