// Health of the two AI features, one row a day (docs/superpowers/specs/2026-10-15-health-checks-design.md).
// Ask is rolled up from the asks table by the hourly cron, so a question costs no extra write; autofill adds to its
// row when a request ends. Nothing here keeps what anyone typed. Before migration 0028 every function does nothing.

import { DAY } from '../lib/scoring';
import { londonDateString } from '../lib/time';
import { isFlagged, successRate, type Outcome } from '../lib/health';
import { HEALTH_FEATURES, type FeatureHealth, type Health, type HealthDay, type HealthFeature, type TestResult } from '../shared/health';
import { londonDayStart } from './ask';

export const HEALTH_DAYS = 14;
/** The admin's own test question: not a visitor's, so it stays out of the numbers. */
export const ADMIN_TEST_WHO = 'admin-test';
const TESTS_KEY = 'health_test';
const DAY_LONGEST = 26 * 3_600_000;

interface Counts { ok: number; failed: number; other: number; ms_sum: number; ms_max: number; last_error: string | null }

/** One London day of questions, straight from the asks table. A question still waiting counts for nothing yet. */
async function askDay(db: D1Database, start: number): Promise<Counts> {
  const end = londonDayStart(start + DAY_LONGEST);
  const dur = "CASE WHEN status IN ('done', 'failed') AND finished_at IS NOT NULL THEN finished_at - asked_at END";
  const row = await db.prepare(
    `SELECT COALESCE(SUM(status = 'done'), 0) AS ok, COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(${dur}), 0) AS ms_sum, COALESCE(MAX(${dur}), 0) AS ms_max,
       (SELECT error FROM asks WHERE status = 'failed' AND ip_hash != ?1 AND asked_at >= ?2 AND asked_at < ?3 ORDER BY asked_at DESC LIMIT 1) AS last_error
     FROM asks WHERE ip_hash != ?1 AND asked_at >= ?2 AND asked_at < ?3`,
  ).bind(ADMIN_TEST_WHO, start, end).first<Omit<Counts, 'other'>>();
  return { ok: row?.ok ?? 0, failed: row?.failed ?? 0, other: 0, ms_sum: row?.ms_sum ?? 0, ms_max: row?.ms_max ?? 0, last_error: row?.last_error ?? null };
}

const UPSERT_REPLACE = `INSERT INTO health_daily (day, feature, ok, failed, other, ms_sum, ms_max, last_error) VALUES (?, 'ask', ?, ?, ?, ?, ?, ?)
  ON CONFLICT (day, feature) DO UPDATE SET ok = excluded.ok, failed = excluded.failed, other = excluded.other,
    ms_sum = excluded.ms_sum, ms_max = excluded.ms_max, last_error = excluded.last_error`;

/** Hourly: today and yesterday are recomputed from the asks table (a late answer changes yesterday), so the numbers survive the 7 day purge. */
export async function rollupAsks(db: D1Database, now: number) {
  const today = londonDayStart(now);
  for (const start of [londonDayStart(today - 1), today]) {
    const c = await askDay(db, start);
    if (c.ok + c.failed === 0) continue;
    await db.prepare(UPSERT_REPLACE).bind(londonDateString(start), c.ok, c.failed, c.other, c.ms_sum, c.ms_max, c.last_error).run();
  }
}

/** One finished autofill request. `ms` only counts when it worked or failed. Never throws: health must not break a request. */
export async function recordAutofill(db: D1Database, now: number, outcome: Outcome, ms: number, error?: string) {
  try {
    const timed = outcome === 'other' ? 0 : Math.max(0, Math.round(ms));
    await db.prepare(
      `INSERT INTO health_daily (day, feature, ok, failed, other, ms_sum, ms_max, last_error) VALUES (?, 'autofill', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, feature) DO UPDATE SET ok = ok + excluded.ok, failed = failed + excluded.failed, other = other + excluded.other,
         ms_sum = ms_sum + excluded.ms_sum, ms_max = MAX(ms_max, excluded.ms_max), last_error = COALESCE(excluded.last_error, last_error)`,
    ).bind(londonDateString(now), outcome === 'ok' ? 1 : 0, outcome === 'failed' ? 1 : 0, outcome === 'other' ? 1 : 0, timed, timed,
      outcome === 'failed' && error ? error.slice(0, 200) : null).run();
  } catch (e) {
    console.warn('autofill health not recorded', e);
  }
}

/* ---------- the last test of each feature ---------- */

type Tests = Partial<Record<HealthFeature, TestResult>>;

export async function lastTests(db: D1Database): Promise<Tests> {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(TESTS_KEY).first<{ value: string }>();
    return row ? (JSON.parse(row.value) as Tests) : {};
  } catch {
    return {};
  }
}

export async function saveTest(db: D1Database, result: TestResult, now: number) {
  const all = { ...(await lastTests(db)), [result.feature]: result };
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(TESTS_KEY, JSON.stringify(all), now).run();
  clearHealth();
}

/* ---------- reading, for the Insights page ---------- */

const CACHE_MS = 60_000;
let cache: { at: number; value: Health } | null = null;
export const clearHealth = () => { cache = null; };

const toDay = (day: string, c: Pick<Counts, 'ok' | 'failed' | 'other' | 'ms_sum' | 'ms_max'>): HealthDay => ({
  day, ok: c.ok, failed: c.failed, other: c.other, max_ms: c.ms_max,
  avg_ms: c.ok + c.failed > 0 ? Math.round(c.ms_sum / (c.ok + c.failed)) : null,
});

export async function loadHealth(db: D1Database, now: number): Promise<Health> {
  if (cache && now >= cache.at && now - cache.at < CACHE_MS) return cache.value;
  let value: Health;
  try {
    const days = Array.from({ length: HEALTH_DAYS }, (_, i) => londonDateString(now - (HEALTH_DAYS - 1 - i) * DAY));
    const [rows, tests, askToday] = await Promise.all([
      db.prepare('SELECT * FROM health_daily WHERE day >= ?').bind(days[0]).all<Counts & { day: string; feature: HealthFeature }>(),
      lastTests(db),
      askDay(db, londonDayStart(now)),
    ]);
    const today = days[days.length - 1];
    const features: FeatureHealth[] = HEALTH_FEATURES.map(feature => {
      const byDay = new Map(rows.results.filter(r => r.feature === feature).map(r => [r.day, r]));
      // Ask's row for today is up to an hour old; the live count is cheap, so show that
      if (feature === 'ask') byDay.set(today, { day: today, feature, ...askToday });
      const list = days.map(day => toDay(day, byDay.get(day) ?? { ok: 0, failed: 0, other: 0, ms_sum: 0, ms_max: 0 }));
      const t = list[list.length - 1];
      const lastError = [...days].reverse().map(d => byDay.get(d)?.last_error).find(Boolean) ?? null;
      return { feature, days: list, rate_today: successRate(t), flagged: isFlagged(t), last_error: lastError, test: tests[feature] ?? null };
    });
    value = { features, updated_at: now };
  } catch {
    value = null; // migration 0028 is not applied yet
  }
  cache = { at: now, value };
  return value;
}
