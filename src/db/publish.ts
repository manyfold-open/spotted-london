// Publishing what agents verified, and taking it back (SPEC §13.4).
//
// A Triage note that the server marked publish_ready can be published by the admin in one click
// ('suggest' mode) or at once by the server ('auto' mode). Either way the pop-up becomes 'community'
// (public, votes and reports still apply), the notes are resolved, and an audit row names the
// agents behind it. undoAgent() replays those rows to put an agent's work back in the queue.

import type { PopupRow } from '../types';
import { newId } from '../lib/util';
import { recompute } from './popups';

export type PublishMode = 'suggest' | 'auto';

/** Agent findings that put a pop-up back in front of the admin. */
export const FLAGGING_VERDICTS = ['needs_check', 'likely_fake', 'duplicate', 'details_changed', 'cancelled', 'out_of_scope'];

/** An open note says ready, and no open note says otherwise. */
export const isReady = (notes: readonly { verdict: string; publish_ready: number }[]) =>
  notes.some(n => n.publish_ready) && !notes.some(n => FLAGGING_VERDICTS.includes(n.verdict));

export async function publishMode(db: D1Database): Promise<PublishMode> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'auto_publish'").first<{ value: string }>();
  return row?.value === 'auto' ? 'auto' : 'suggest';
}

export async function setPublishMode(db: D1Database, mode: PublishMode, now: number): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('auto_publish', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(mode, now).run();
}

async function log(db: D1Database, actor: string, action: string, popupId: string, detail: unknown, now: number) {
  await db.prepare('INSERT INTO audit_log (id, admin_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), actor, action, 'popup', popupId, JSON.stringify(detail), now).run();
  clearPublishStats(); // every row written here (publish, undo) changes the numbers
}

type OpenNote = { id: string; agent_id: string; verdict: string; publish_ready: number };

/**
 * Moves a pending pop-up to 'community' when its open notes say it is ready. `actor` is the admin's id,
 * or the agent's own user id in auto mode. Returns false when it was no longer pending or not ready. A pop-up with open or
 * very long dates (`date_kind`) is never published this way: an admin decides.
 */
export async function publishReady(db: D1Database, popupId: string, actor: string, via: 'batch' | 'auto', now: number): Promise<boolean> {
  const { results: notes } = await db.prepare('SELECT id, agent_id, verdict, publish_ready FROM agent_notes WHERE popup_id = ? AND resolved_at IS NULL').bind(popupId).all<OpenNote>();
  if (!isReady(notes)) return false;
  const moved = await db.prepare("UPDATE popups SET status = 'community', updated_at = ? WHERE id = ? AND status = 'pending' AND date_kind IS NULL").bind(now, popupId).run();
  if (!moved.meta.changes) return false;
  await db.prepare('UPDATE agent_notes SET resolved_at = ? WHERE popup_id = ? AND resolved_at IS NULL').bind(now, popupId).run();
  await recompute(db, popupId, now);
  const ready = notes.filter(n => n.publish_ready);
  await log(db, actor, 'popup.agent_publish', popupId, { agents: [...new Set(ready.map(n => n.agent_id))], note_ids: ready.map(n => n.id), via, from: 'pending', to: 'community' }, now);
  return true;
}

export interface UndoResult { reverted: number; skipped: { id: string; title: string; reason: string }[] }

/**
 * Puts back in the review queue every pop-up this agent's work made public since `since`: the ones it
 * marked ready and had published, and the ones it drafted itself. A pop-up the community has voted on,
 * or whose status changed since, is listed and left alone.
 */
export async function undoAgent(db: D1Database, agent: { id: string; user_id: string }, since: number, actor: string, now: number): Promise<UndoResult> {
  const { results } = await db.prepare(
    `SELECT p.id, p.title, p.status, p.voter_count FROM popups p WHERE
       p.id IN (SELECT target_id FROM audit_log WHERE action = 'popup.agent_publish' AND created_at >= ?1
                AND EXISTS (SELECT 1 FROM json_each(json_extract(detail, '$.agents')) j WHERE j.value = ?2))
       OR (p.created_by = ?3 AND p.created_at >= ?1 AND p.status = 'community')`,
  ).bind(since, agent.id, agent.user_id).all<Pick<PopupRow, 'id' | 'title' | 'status' | 'voter_count'>>();
  const out: UndoResult = { reverted: 0, skipped: [] };
  for (const p of results) {
    if (p.status !== 'community') { out.skipped.push({ id: p.id, title: p.title, reason: `its status is now ${p.status}` }); continue; }
    if (p.voter_count > 0) { out.skipped.push({ id: p.id, title: p.title, reason: 'people have voted on it' }); continue; }
    const moved = await db.prepare("UPDATE popups SET status = 'pending', lease_agent = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'community'").bind(now, p.id).run();
    if (!moved.meta.changes) continue;
    await log(db, actor, 'popup.agent_publish_undo', p.id, { agent: agent.id, since }, now);
    out.reverted += 1;
  }
  // What the agent removed or ended on its own (duplicates, out of scope, cancelled) goes back to the status it had.
  const { results: gone } = await db.prepare(
    `SELECT a.target_id AS id, p.title, p.status, json_extract(a.detail, '$.from') AS before, json_extract(a.detail, '$.to') AS after
     FROM audit_log a JOIN popups p ON p.id = a.target_id
     WHERE a.action IN ('popup.agent_remove', 'popup.agent_end') AND a.created_at >= ? AND json_extract(a.detail, '$.agent') = ?`,
  ).bind(since, agent.id).all<{ id: string; title: string; status: string; before: string; after: string }>();
  for (const g of gone) {
    if (g.status !== g.after) { out.skipped.push({ id: g.id, title: g.title, reason: `its status is now ${g.status}` }); continue; }
    const back = await db.prepare('UPDATE popups SET status = ?, merged_into = NULL, updated_at = ? WHERE id = ? AND status = ?').bind(g.before, now, g.id, g.after).run();
    if (!back.meta.changes) continue;
    await log(db, actor, 'popup.agent_remove_undo', g.id, { agent: agent.id, since, to: g.before }, now);
    out.reverted += 1;
  }
  return out;
}

/** What each agent has published, and how much of it was taken back or went bad. */
type Stats = Map<string, { published: number; undone: number; hidden_after: number }>;
/**
 * The numbers are the same for every admin and scan the audit log, so one Worker keeps them for 5 minutes.
 * The /admin/agent page asks every couple of minutes while it is open: on 10 Oct 2026 that was 1.5 million rows read in a day.
 * Publishing and undoing clear it in the Worker that did them; another Worker can be up to 5 minutes behind.
 */
export const STATS_TTL = 5 * 60_000;
let cached: { at: number; stats: Stats } | null = null;
export const clearPublishStats = () => { cached = null; };

export async function publishStats(db: D1Database, now = Date.now(), fresh = false): Promise<Stats> {
  if (!fresh && cached && now >= cached.at && now - cached.at < STATS_TTL) return cached.stats;
  const stats = await computePublishStats(db);
  cached = { at: now, stats };
  return stats;
}

async function computePublishStats(db: D1Database): Promise<Stats> {
  const stats: Stats = new Map();
  const get = (id: string) => stats.get(id) ?? stats.set(id, { published: 0, undone: 0, hidden_after: 0 }).get(id)!;
  const [{ results: published }, { results: undone }] = await Promise.all([
    db.prepare(
      `SELECT j.value AS agent_id, COUNT(*) AS n, SUM(p.status IN ('hidden', 'removed')) AS bad
       FROM audit_log a JOIN json_each(json_extract(a.detail, '$.agents')) j JOIN popups p ON p.id = a.target_id
       WHERE a.action = 'popup.agent_publish' GROUP BY j.value`,
    ).all<{ agent_id: string; n: number; bad: number | null }>(),
    db.prepare("SELECT json_extract(detail, '$.agent') AS agent_id, COUNT(*) AS n FROM audit_log WHERE action = 'popup.agent_publish_undo' GROUP BY 1").all<{ agent_id: string; n: number }>(),
  ]);
  for (const r of published) Object.assign(get(r.agent_id), { published: r.n, hidden_after: r.bad ?? 0 });
  for (const r of undone) get(r.agent_id).undone = r.n;
  return stats;
}
