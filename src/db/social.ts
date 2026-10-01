// Social posts for Scout (docs/superpowers/specs/2026-10-01-social-posts-via-apify-design.md).
// Cron starts one Apify run per due social source, checks open runs on later ticks, filters the
// posts and stores the ones worth Scout's time. Scout reads them through get_social_posts.
// This file never writes scout_sources.due_at or last_checked_at: those belong to Scout.

import { DAY } from '../lib/scoring';
import { newId } from '../lib/util';
import { ApifyError, abortRun, getItems, getRun, runState, startRun } from '../lib/apify';
import { ACTORS, buildInput, itemsUsd, MAX_ITEMS, parseItem, passesFilter, reserveUsd, socialMode, type SocialItem } from '../lib/social';
import type { SourceRow } from './scout';

export interface SocialDeps { db: D1Database; token?: string; fetch?: typeof fetch }

export interface SocialRunRow {
  id: string;
  source_id: string;
  apify_run_id: string | null;
  status: 'running' | 'done' | 'failed' | 'skipped_budget';
  items: number;
  kept: number;
  cost_usd: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface SocialPostRow {
  id: string;
  url: string;
  platform: 'instagram' | 'threads';
  source_id: string;
  run_id: string | null;
  author: string | null;
  body: string | null;
  image_urls: string | null;
  posted_at: number | null;
  fetched_at: number;
  handled_at: number | null;
}

/** Caps spend in any rolling 30 days. US$1 under the Apify free plan's US$5, because Apify's billing cycle starts on the signup day, not ours. */
export const SOCIAL_MONTHLY_BUDGET_USD = 4;
/** Scout is offered a post for this long after it was fetched. */
export const POST_OFFER = 14 * DAY;
/** Posts and runs older than this are removed. */
const KEEP = 90 * DAY;
const HOUR = 3_600_000;
const RUN_TIMEOUT = 30 * 60_000;
const BUDGET_WINDOW = 30 * DAY;
const CHECKS_PER_TICK = 10;
const RETRY_AFTER = 6 * HOUR;
const STRIKES = 3;
const START_PER_TICK = 3;

/** Money spent or held in the last 30 days. Open runs count at their worst case. */
async function spentRecently(db: D1Database, now: number): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM social_runs WHERE started_at >= ?').bind(now - BUDGET_WINDOW).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function socialSummary(db: D1Database, configured: boolean, now: number) {
  return { configured, spent_usd: Math.round((await spentRecently(db, now)) * 100) / 100, cap_usd: SOCIAL_MONTHLY_BUDGET_USD };
}

/** Called by cron every 10 minutes. Does nothing until APIFY_TOKEN is set. */
export async function runSocial(deps: SocialDeps, now: number): Promise<void> {
  if (!deps.token) return;
  await checkOpenRuns(deps, deps.token, now);
  await startDueRuns(deps, deps.token, now);
}

/* ---------- checking runs ---------- */

type OpenRun = SocialRunRow & { target: string };

async function checkOpenRuns(deps: SocialDeps, token: string, now: number) {
  const { results } = await deps.db.prepare(
    `SELECT r.*, s.target FROM social_runs r JOIN scout_sources s ON s.id = r.source_id WHERE r.status = 'running' ORDER BY r.started_at LIMIT ${CHECKS_PER_TICK}`,
  ).all<OpenRun>();
  for (const r of results) {
    try {
      await checkRun(deps, token, r, now);
    } catch (e) {
      // A network blip leaves the run open for the next tick; the timeout ends it for good.
      console.error('social run check failed', r.id, e);
      if (now - r.started_at > RUN_TIMEOUT) await failRun(deps.db, r, now, 'Could not reach Apify before the run timed out.', heldCost(r, null));
    }
  }
}

async function checkRun(deps: SocialDeps, token: string, r: OpenRun, now: number) {
  const { db } = deps;
  const mode = socialMode(r.target);
  if (!r.apify_run_id || !mode) return failRun(db, r, now, 'This source cannot be fetched.', heldCost(r, null));

  const run = await getRun(deps.fetch, token, r.apify_run_id);
  const state = runState(run.status);
  if (state === 'pending') {
    if (now - r.started_at > RUN_TIMEOUT) {
      await abortRun(deps.fetch, token, r.apify_run_id);
      await failRun(db, r, now, 'The run took longer than 30 minutes and was stopped.', heldCost(r, run.usageTotalUsd));
    }
    return;
  }
  if (state === 'failed') return failRun(db, r, now, `The Apify run ended as ${run.status.toLowerCase()}.`, heldCost(r, run.usageTotalUsd));

  const raw = run.defaultDatasetId ? await getItems(deps.fetch, token, run.defaultDatasetId, MAX_ITEMS) : [];
  const items = raw.map(x => parseItem(mode.platform, x)).filter((x): x is SocialItem => x !== null);
  // Posts are charged before the keyword filter, so cost follows what was fetched.
  const cost = Math.max(run.usageTotalUsd ?? 0, itemsUsd(mode.platform, raw.length));
  if (raw.length > 0 && items.length === 0) return failRun(db, r, now, 'The actor sent posts in a shape we do not recognise.', cost);

  const kept = await keepNew(db, items.filter(i => passesFilter(i, now)));
  const stmts = kept.map(i =>
    db.prepare('INSERT OR IGNORE INTO social_posts (id, url, platform, source_id, run_id, author, body, image_urls, posted_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`sp_${newId()}`, i.url, i.platform, r.source_id, r.id, i.author, i.body.slice(0, 2000), JSON.stringify(i.image_urls), i.posted_at, now));
  stmts.push(db.prepare("UPDATE social_runs SET status = 'done', items = ?, kept = ?, cost_usd = ?, finished_at = ? WHERE id = ? AND status = 'running'").bind(raw.length, kept.length, cost, now, r.id));
  await db.batch(stmts);
}

/** Drops posts already stored, already read by Scout, or already on Spotted. */
async function keepNew(db: D1Database, items: SocialItem[]): Promise<SocialItem[]> {
  if (!items.length) return [];
  const urls = items.map(i => i.url);
  const marks = urls.map(() => '?').join(',');
  const queries = [
    `SELECT url FROM social_posts WHERE url IN (${marks})`,
    `SELECT url FROM scout_seen WHERE url IN (${marks})`,
    `SELECT source_url AS url FROM popups WHERE source_url IN (${marks})`,
    `SELECT url FROM popup_links WHERE url IN (${marks})`,
  ];
  const answers = await db.batch(queries.map(q => db.prepare(q).bind(...urls)));
  const known = new Set(answers.flatMap(a => (a.results as { url: string }[]).map(x => x.url)));
  const seen = new Set<string>();
  return items.filter(i => {
    if (known.has(i.url) || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

/** A failed run may still have been billed per result, and Apify can report only compute usage: never go below what we held. */
const heldCost = (r: SocialRunRow, usage: number | null) => Math.max(r.cost_usd, usage ?? 0);

/** Ends a run as failed and stores `cost` (heldCost, or 0 when Apify refused to start a run). */
async function failRun(db: D1Database, r: SocialRunRow, now: number, error: string, cost: number) {
  await db.prepare("UPDATE social_runs SET status = 'failed', error = ?, cost_usd = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .bind(error, cost, now, r.id).run();
  await pauseIfFailing(db, r.source_id, error, now);
}

/** Three failed runs in a row since the admin last touched the source pause it. */
async function pauseIfFailing(db: D1Database, sourceId: string, error: string, now: number) {
  const src = await db.prepare('SELECT status, note, updated_at FROM scout_sources WHERE id = ?').bind(sourceId).first<{ status: string; note: string | null; updated_at: number }>();
  if (!src || src.status !== 'active') return;
  const { results } = await db.prepare(
    "SELECT status FROM social_runs WHERE source_id = ? AND status IN ('done', 'failed') AND started_at >= ? ORDER BY started_at DESC LIMIT ?",
  ).bind(sourceId, src.updated_at, STRIKES).all<{ status: string }>();
  if (results.length < STRIKES || !results.every(x => x.status === 'failed')) return;
  const note = `Paused after ${STRIKES} failed fetches in a row. Last error: ${error}${src.note ? ` Earlier note: ${src.note}` : ''}`.slice(0, 300);
  await db.prepare("UPDATE scout_sources SET status = 'paused', note = ?, updated_at = ? WHERE id = ?").bind(note, now, sourceId).run();
}

/* ---------- starting runs ---------- */

type LastRun = { source_id: string; status: string; at: number };

function isDue(s: SourceRow, last: LastRun | undefined, now: number) {
  if (!last) return true;
  if (last.status === 'running') return false;
  return now - last.at >= (last.status === 'failed' ? RETRY_AFTER : s.every_days * DAY);
}

async function startDueRuns(deps: SocialDeps, token: string, now: number) {
  const { db } = deps;
  const { results: sources } = await db.prepare("SELECT * FROM scout_sources WHERE kind = 'social' AND status = 'active'").all<SourceRow>();
  if (!sources.length) return;
  // SQLite returns the status of the row that holds the MAX, so this is each source's latest real run.
  const { results: last } = await db.prepare(
    "SELECT source_id, status, MAX(started_at) AS at FROM social_runs WHERE status != 'skipped_budget' GROUP BY source_id",
  ).all<LastRun>();
  const lastBy = new Map(last.map(l => [l.source_id, l]));

  const due: { s: SourceRow; at: number }[] = [];
  for (const s of sources) {
    if (socialMode(s.target) && isDue(s, lastBy.get(s.id), now)) due.push({ s, at: lastBy.get(s.id)?.at ?? 0 });
  }
  due.sort((a, b) => a.at - b.at);

  let spent = await spentRecently(db, now);
  for (const { s } of due.slice(0, START_PER_TICK)) {
    const mode = socialMode(s.target)!;
    const reserve = reserveUsd(mode.platform);
    if (spent + reserve > SOCIAL_MONTHLY_BUDGET_USD) {
      await noteBudgetSkip(db, s.id, now);
      continue;
    }
    const id = `sr_${newId()}`;
    // The row goes in first, holding the worst case, so a crash between here and Apify's answer
    // cannot lose track of a run that may exist. checkRun ends such a row on the next tick.
    await db.prepare("INSERT INTO social_runs (id, source_id, status, cost_usd, started_at) VALUES (?, ?, 'running', ?, ?)").bind(id, s.id, reserve, now).run();
    try {
      const run = await startRun(deps.fetch, token, ACTORS[mode.platform], buildInput(mode, MAX_ITEMS, Math.min(14, Math.max(2, s.every_days + 1))), {
        maxItems: MAX_ITEMS,
        maxTotalChargeUsd: Math.round(reserve * 10_000) / 10_000,
        timeoutSecs: RUN_TIMEOUT / 1000,
      });
      await db.prepare("UPDATE social_runs SET apify_run_id = ? WHERE id = ? AND status = 'running'").bind(run.id, id).run();
      spent += reserve;
    } catch (e) {
      const error = e instanceof Error ? e.message : 'The run could not be started.';
      console.error('social run start failed', s.id, e);
      // A 4xx answer from Apify (other than 408) means it refused and created no run. Anything else (5xx, 408, network, unreadable answer) means one may exist.
      const refused = e instanceof ApifyError && e.httpStatus !== undefined && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 408;
      const stored = { id, source_id: s.id, cost_usd: reserve } as SocialRunRow;
      await failRun(db, stored, now, error, refused ? 0 : reserve);
      if (!refused) spent += reserve;
    }
  }
}

/** One note per source per day, so the admin screen can show why nothing was fetched. */
async function noteBudgetSkip(db: D1Database, sourceId: string, now: number) {
  const has = await db.prepare("SELECT 1 FROM social_runs WHERE source_id = ? AND status = 'skipped_budget' AND started_at > ?").bind(sourceId, now - DAY).first();
  if (has) return;
  await db.prepare("INSERT INTO social_runs (id, source_id, status, started_at, finished_at) VALUES (?, ?, 'skipped_budget', ?, ?)").bind(`sr_${newId()}`, sourceId, now, now).run();
}

/* ---------- reading posts (Scout, admin screen) ---------- */

/** How many posts Scout has not handled yet, per source. */
export async function newPostCounts(db: D1Database, sourceIds: string[], now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!sourceIds.length) return out;
  const { results } = await db.prepare(
    `SELECT source_id, COUNT(*) AS n FROM social_posts WHERE handled_at IS NULL AND fetched_at > ? AND source_id IN (${sourceIds.map(() => '?').join(',')}) GROUP BY source_id`,
  ).bind(now - POST_OFFER, ...sourceIds).all<{ source_id: string; n: number }>();
  for (const r of results) out.set(r.source_id, r.n);
  return out;
}

/** Posts Scout has not handled, newest first. */
export async function postsFor(db: D1Database, sourceId: string, limit: number, now: number): Promise<SocialPostRow[]> {
  const { results } = await db.prepare(
    'SELECT * FROM social_posts WHERE source_id = ? AND handled_at IS NULL AND fetched_at > ? ORDER BY COALESCE(posted_at, fetched_at) DESC LIMIT ?',
  ).bind(sourceId, now - POST_OFFER, limit).all<SocialPostRow>();
  return results;
}

/** Scout reported these pages (submit_draft or skip_url), so it is not offered them again. */
export async function markPostsHandled(db: D1Database, urls: string[], now: number): Promise<void> {
  if (!urls.length) return;
  await db.prepare(`UPDATE social_posts SET handled_at = ? WHERE handled_at IS NULL AND url IN (${urls.map(() => '?').join(',')})`).bind(now, ...urls).run();
}

/** Each source's latest run, for the admin screen. */
export async function lastRuns(db: D1Database, sourceIds: string[]): Promise<Map<string, SocialRunRow>> {
  if (!sourceIds.length) return new Map();
  const { results } = await db.prepare(
    `SELECT r.* FROM social_runs r WHERE r.source_id IN (${sourceIds.map(() => '?').join(',')})
       AND r.started_at = (SELECT MAX(started_at) FROM social_runs WHERE source_id = r.source_id)`,
  ).bind(...sourceIds).all<SocialRunRow>();
  return new Map(results.map(r => [r.source_id, r]));
}

/** Daily clean-up. Posts go first because they point at runs; a run stays while any post still points at it. */
export async function purgeSocial(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM social_posts WHERE fetched_at < ?').bind(now - KEEP),
    db.prepare('DELETE FROM social_runs WHERE started_at < ? AND id NOT IN (SELECT run_id FROM social_posts WHERE run_id IS NOT NULL)').bind(now - KEEP),
  ]);
}
