// Scheduled jobs (SPEC §13.1). Plain deterministic code; AI agents run on Manyfold, and cron only starts and checks them.

import type { Bindings, PopupRow } from './types';
import { DAY, hot, KARMA } from './lib/scoring';
import { awardKarma } from './db/karma';
import { runAgents } from './db/agents';
import { SEEN_KEEP } from './db/scout';
import { purgeSocial, runSocial } from './db/social';
import { buildPopupSnapshot } from './db/snapshot';

export async function runCron(cron: string, env: Bindings, now = Date.now()) {
  switch (cron) {
    case '*/10 * * * *':
      await endExpired(env.DB, now);
      await buildPopupSnapshot(env.DB, now).catch(e => console.error('snapshot cron failed', e));
      // AI agents on Manyfold: check open runs, start the ones that are due (SPEC §13.4)
      await runAgents(env, now).catch(e => console.error('agents cron failed', e));
      // Instagram and Threads posts for Scout, through Apify (does nothing until APIFY_TOKEN is set)
      await runSocial({ db: env.DB, token: env.APIFY_TOKEN }, now).catch(e => console.error('social cron failed', e));
      break;
    case '0 * * * *':
      await recomputeHot(env.DB, now);
      await reminders(env.DB, now);
      break;
    case '0 4 * * *':
      await settleKarma(env.DB, now);
      await purgeCheckinCoordinates(env.DB, now);
      await purgeExpiredAuth(env.DB, now);
      await purgeScoutSeen(env.DB, now);
      await purgeSocial(env.DB, now);
      break;
    default:
      console.warn('unknown cron', cron);
  }
}

/** Past pop-ups leave the lists. The community verdict becomes final if no admin ruled. */
export async function endExpired(db: D1Database, now: number) {
  await db.batch([
    db.prepare("UPDATE popups SET final_verdict = 'real' WHERE end_at < ? AND status IN ('verified_community', 'verified_admin') AND final_verdict IS NULL").bind(now),
    db.prepare("UPDATE popups SET final_verdict = 'fake' WHERE end_at < ? AND status = 'hidden' AND confidence <= 0.3 AND final_verdict IS NULL").bind(now),
    db.prepare("UPDATE popups SET status = 'ended', updated_at = ? WHERE end_at < ? AND status IN ('pending', 'community', 'verified_community', 'verified_admin', 'hidden')").bind(now, now),
  ]);
}

/** Smallest change in hot worth a write. Hot sits in an index, so every UPDATE costs two rows written. */
const HOT_EPSILON = 0.01;

/**
 * Hot decays with time, so it is refreshed for everything still upcoming or live.
 * Only rows that moved by HOT_EPSILON or more are written. Returns how many were.
 */
export async function recomputeHot(db: D1Database, now: number) {
  const { results } = await db.prepare(
    "SELECT id, status, quality_pos, quality_neg, start_at, end_at, hot FROM popups WHERE end_at >= ? AND status IN ('community', 'verified_community', 'verified_admin')",
  ).bind(now).all<Pick<PopupRow, 'id' | 'status' | 'quality_pos' | 'quality_neg' | 'start_at' | 'end_at' | 'hot'>>();
  const stmts = results.flatMap(p => {
    const h = hot({ status: p.status, qualityPos: p.quality_pos, qualityNeg: p.quality_neg, startAt: p.start_at, endAt: p.end_at }, now);
    return Math.abs(h - p.hot) >= HOT_EPSILON ? [db.prepare('UPDATE popups SET hot = ? WHERE id = ?').bind(h, p.id)] : [];
  });
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/**
 * Votes that matched the final verdict earn +1, misses cost -2.
 * Posters also earn +1 per 10 upvotes, up to +20 per post (SPEC §4.5).
 */
export async function settleKarma(db: D1Database, now: number) {
  const { results: votes } = await db.prepare(
    `SELECT v.user_id, v.popup_id, v.value, p.final_verdict FROM votes v JOIN popups p ON p.id = v.popup_id
     WHERE v.kind = 'existence' AND v.settled = 0 AND p.final_verdict IS NOT NULL AND p.status IN ('ended', 'removed', 'verified_admin')
     LIMIT 1000`,
  ).all<{ user_id: string; popup_id: string; value: number; final_verdict: 'real' | 'fake' }>();
  for (const v of votes) {
    const matched = (v.value === 1) === (v.final_verdict === 'real');
    await awardKarma(db, v.user_id, matched ? KARMA.voteMatched : KARMA.voteMissed, matched ? 'vote_matched' : 'vote_missed', v.popup_id, now);
    await db.prepare("UPDATE votes SET settled = 1 WHERE user_id = ? AND popup_id = ? AND kind = 'existence'").bind(v.user_id, v.popup_id).run();
  }

  const { results: ended } = await db.prepare(
    `SELECT id, created_by, quality_pos FROM popups WHERE status = 'ended' AND quality_pos >= 10
       AND id NOT IN (SELECT ref_id FROM karma_log WHERE reason = 'upvotes') LIMIT 500`,
  ).all<{ id: string; created_by: string; quality_pos: number }>();
  for (const p of ended) {
    const delta = Math.min(KARMA.upvoteCapPerPost, Math.floor(p.quality_pos / 10) * KARMA.per10Upvotes);
    await awardKarma(db, p.created_by, delta, 'upvotes', p.id, now);
  }
  return { votes: votes.length, posts: ended.length };
}

/** Check-in coordinates are kept for 30 days, then only distance and validity remain (SPEC §8). */
export async function purgeCheckinCoordinates(db: D1Database, now: number) {
  await db.prepare('UPDATE checkins SET lat = NULL, lng = NULL WHERE created_at < ? AND lat IS NOT NULL').bind(now - 30 * DAY).run();
}

/** Finds saves due a reminder. TODO(email): send through Resend once the account exists. */
export async function reminders(db: D1Database, now: number) {
  const { results } = await db.prepare(
    `SELECT s.user_id, p.id, p.title FROM saves s JOIN popups p ON p.id = s.popup_id
     WHERE s.remind = 1 AND p.start_at BETWEEN ? AND ? AND p.status IN ('community', 'verified_community', 'verified_admin')`,
  ).bind(now + 23 * 3_600_000, now + 24 * 3_600_000).all();
  if (results.length) console.log(`reminders due: ${results.length}`);
  return results.length;
}

/** Expired sessions, used or stale sign-in links and abandoned OAuth attempts. */
export async function purgeExpiredAuth(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM login_tokens WHERE created_at < ?').bind(now - DAY),
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
  ]);
}

/** Pages Scout skipped are forgotten after 90 days; pages that led to drafts stay for the track record. */
export async function purgeScoutSeen(db: D1Database, now: number) {
  await db.prepare("DELETE FROM scout_seen WHERE outcome != 'sent' AND seen_at < ?").bind(now - SEEN_KEEP).run();
}
