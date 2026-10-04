import type { PopupRow } from '../types';
import { hot, KARMA, nextStatus, round, wilson, type Status } from '../lib/scoring';
import { awardKarma } from './karma';

interface VoteRow { user_id: string; kind: 'existence' | 'quality'; value: 1 | -1; weight: number; ip_hash: string | null }

/**
 * Sums votes, applies one-vote-per-IP, updates cached aggregates and moves the
 * status if community signals say so (SPEC §4.2 and §4.3). Returns the status change, if any.
 */
export async function recompute(db: D1Database, popupId: string, now: number): Promise<{ from: Status; to: Status } | null> {
  const p = await db.prepare('SELECT * FROM popups WHERE id = ?').bind(popupId).first<PopupRow>();
  if (!p) return null;

  const [{ results: votes }, checkins, reports] = await Promise.all([
    db.prepare('SELECT user_id, kind, value, weight, ip_hash FROM votes WHERE popup_id = ?').bind(popupId).all<VoteRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE popup_id = ? AND valid = 1').bind(popupId).first<{ n: number }>(),
    db.prepare('SELECT COALESCE(SUM(weight), 0) AS w FROM reports WHERE popup_id = ? AND resolution IS NULL').bind(popupId).first<{ w: number }>(),
  ]);

  // Several accounts on one IP count once: keep only the heaviest existence vote per IP.
  const byIp = new Map<string, VoteRow>();
  for (const v of votes.filter(v => v.kind === 'existence')) {
    const key = v.ip_hash ?? `user:${v.user_id}`;
    const cur = byIp.get(key);
    if (!cur || v.weight > cur.weight) byIp.set(key, v);
  }
  const counted = [...byIp.values()];
  const existPos = round(counted.filter(v => v.value === 1).reduce((s, v) => s + v.weight, 0), 4);
  const existNeg = round(counted.filter(v => v.value === -1).reduce((s, v) => s + v.weight, 0), 4);
  const voterCount = counted.filter(v => v.weight > 0).length;
  const quality = votes.filter(v => v.kind === 'quality');
  const qualityPos = quality.filter(v => v.value === 1).length;
  const qualityNeg = quality.filter(v => v.value === -1).length;
  const checkinCount = checkins?.n ?? 0;
  const reportWeight = round(reports?.w ?? 0, 4);

  const to = nextStatus({ status: p.status, startAt: p.start_at, endAt: p.end_at, existPos, existNeg, voterCount, checkinCount, reportWeight }, now);
  const confidence = round(wilson(existPos, existNeg), 4);
  const h = hot({ status: to, qualityPos, qualityNeg, startAt: p.start_at, endAt: p.end_at }, now);

  await db.prepare(
    `UPDATE popups SET exist_pos = ?, exist_neg = ?, voter_count = ?, checkin_count = ?, confidence = ?,
       quality_pos = ?, quality_neg = ?, report_weight = ?, hot = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).bind(existPos, existNeg, voterCount, checkinCount, confidence, qualityPos, qualityNeg, reportWeight, h, to, now, popupId).run();

  if (to === p.status) return null;
  await onStatusChange(db, p, to, now);
  return { from: p.status, to };
}

/** Side effects of a status change: poster karma and post counters (SPEC §4.4, §4.5). */
export async function onStatusChange(db: D1Database, p: Pick<PopupRow, 'id' | 'created_by' | 'status'>, to: Status, now: number) {
  const wasVerified = p.status === 'verified_community' || p.status === 'verified_admin';
  const isVerified = to === 'verified_community' || to === 'verified_admin';
  if (isVerified && !wasVerified) {
    const got = await awardKarma(db, p.created_by, KARMA.postVerified, 'post_verified', p.id, now);
    if (got || (await alreadyAwarded(db, p.created_by, 'post_verified', p.id))) {
      await db.prepare(
        `UPDATE users SET verified_posts = (SELECT COUNT(DISTINCT ref_id) FROM karma_log WHERE user_id = ? AND reason = 'post_verified') WHERE id = ?`,
      ).bind(p.created_by, p.created_by).run();
    }
    await db.prepare("UPDATE popups SET final_verdict = 'real' WHERE id = ?").bind(p.id).run();
  }
  if (to === 'removed') {
    await awardKarma(db, p.created_by, KARMA.postRemoved, 'post_removed', p.id, now);
    await db.prepare('UPDATE users SET bad_posts = bad_posts + 1 WHERE id = ?').bind(p.created_by).run();
    await db.prepare("UPDATE popups SET final_verdict = 'fake' WHERE id = ?").bind(p.id).run();
  }
}

async function alreadyAwarded(db: D1Database, userId: string, reason: string, ref: string) {
  return !!(await db.prepare('SELECT 1 FROM karma_log WHERE user_id = ? AND reason = ? AND ref_id = ?').bind(userId, reason, ref).first());
}

/**
 * Column for pop-up queries: 1 when a Triage agent confirmed the post against its source with its own quote (a
 * `publish_ready` note) and no open note has flagged it since. Uses idx_agent_notes_popup. Show it as "Source checked";
 * it never changes `status`, so votes and check-ins still decide `verified_community`.
 */
export const SOURCE_CHECKED_SQL = `(EXISTS (SELECT 1 FROM agent_notes n WHERE n.popup_id = popups.id AND n.publish_ready = 1)
  AND NOT EXISTS (SELECT 1 FROM agent_notes f WHERE f.popup_id = popups.id AND f.resolved_at IS NULL
    AND f.verdict IN ('needs_check', 'likely_fake', 'duplicate', 'details_changed', 'cancelled'))) AS source_checked`;

/** Public JSON shape for a pop-up. */
export function toPublic(p: PopupRow & { cover_key?: string | null; source_checked?: number | null }, extra: Record<string, unknown> = {}) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    host: p.host,
    description: p.description,
    category: p.category,
    price: { type: p.price_type, text: p.price_text },
    location: { address: p.address, borough: p.borough, lat: p.lat, lng: p.lng },
    start_at: p.start_at,
    end_at: p.end_at,
    hours_text: p.hours_text,
    source_url: p.source_url,
    status: p.status,
    verification: {
      confidence: p.confidence,
      weighted_votes: round(p.exist_pos + p.exist_neg, 2),
      voters: p.voter_count,
      checkins: p.checkin_count,
    },
    score: p.quality_pos - p.quality_neg,
    hot: p.hot,
    cover_url: p.cover_key ? `/api/v1/images/${p.cover_key}` : null,
    example: !!p.is_example,
    source_checked: !!p.source_checked,
    created_at: p.created_at,
    ...extra,
  };
}
