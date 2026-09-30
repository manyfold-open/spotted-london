import { DAY, KARMA } from '../lib/scoring';
import { newId } from '../lib/util';

/**
 * Awards karma once per (user, reason, ref). Returns the delta actually applied.
 * Positive awards respect the daily gain cap (SPEC §4.5); penalties always apply.
 */
export async function awardKarma(
  db: D1Database, userId: string, delta: number, reason: string, refId: string, now: number,
): Promise<number> {
  if (delta === 0) return 0;
  let applied = delta;
  if (delta > 0) {
    const row = await db.prepare(
      'SELECT COALESCE(SUM(delta), 0) AS gained FROM karma_log WHERE user_id = ? AND delta > 0 AND created_at > ?',
    ).bind(userId, now - DAY).first<{ gained: number }>();
    applied = Math.min(delta, Math.max(0, KARMA.dailyGainCap - (row?.gained ?? 0)));
    if (applied === 0) return 0;
  }
  const ins = await db.prepare(
    'INSERT OR IGNORE INTO karma_log (id, user_id, delta, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(newId(), userId, applied, reason, refId, now).run();
  if (!ins.meta.changes) return 0;
  await db.prepare('UPDATE users SET karma = karma + ? WHERE id = ?').bind(applied, userId).run();
  return applied;
}
