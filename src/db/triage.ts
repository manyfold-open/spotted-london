// What Triage and Checker agents may do to a post themselves (see src/lib/triage.ts). Every change writes an audit row
// that names the agent and keeps what was there before, so a person can see it and undoAgent() can put it back.

import type { PopupRow } from '../types';
import { newId } from '../lib/util';
import { londonDateString, MAX_DURATION, parseLondonDate } from '../lib/time';
import { DAY } from '../lib/scoring';
import { normalizeQuote } from '../lib/evidence';
import { AGENT_ACTIONS_PER_DAY, cutText, dateOnPage, FixError, MAX_DATE_SHIFT_DAYS, MIN_DESCRIPTION, type Fixes } from '../lib/triage';

export interface ActingAgent { id: string; user_id: string }
export type FixTarget = Pick<PopupRow, 'id' | 'status' | 'description' | 'address' | 'price_text' | 'hours_text' | 'start_at' | 'end_at' | 'voter_count'>;

export const AGENT_ACTIONS = ['popup.agent_fix', 'popup.agent_remove', 'popup.agent_end'];

async function log(db: D1Database, actor: string, action: string, popupId: string, detail: unknown, now: number) {
  await db.prepare('INSERT INTO audit_log (id, admin_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), actor, action, 'popup', popupId, JSON.stringify(detail), now).run();
}

/** How many fixes, removals and endings this agent made in the last 24 hours (uses idx_audit_actor). */
export async function actionsInLastDay(db: D1Database, userId: string, now: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE admin_id = ? AND action IN (${AGENT_ACTIONS.map(() => '?').join(',')}) AND created_at > ?`,
  ).bind(userId, ...AGENT_ACTIONS, now - DAY).first<{ n: number }>();
  return row?.n ?? 0;
}

export const overDailyCap = async (db: D1Database, userId: string, now: number) => (await actionsInLastDay(db, userId, now)) >= AGENT_ACTIONS_PER_DAY;

const dayDiff = (a: number, b: number) => Math.abs(Math.round((Date.parse(londonDateString(a)) - Date.parse(londonDateString(b))) / DAY));

/**
 * Applies a Triage or Checker agent's corrections to a post and returns what changed. Cutting a sentence or blanking a field
 * needs nothing more. Setting a value needs the agent's quote (already found on the page by Spotted): the quote must state
 * the new value. A post people have voted on is left alone, because they confirmed it as it was.
 * Throws FixError, and changes nothing, when any part is not allowed.
 */
export async function applyFixes(db: D1Database, p: FixTarget, fixes: Fixes, quote: string | null, agent: ActingAgent, now: number): Promise<Record<string, [unknown, unknown]>> {
  if (p.voter_count > 0) throw new FixError('People have voted on this post, so it cannot be changed by an agent. Say what is wrong in the note instead.');
  const next: Record<string, unknown> = {};
  const changes: Record<string, [unknown, unknown]> = {};
  const put = (col: string, from: unknown, to: unknown) => { if (from !== to) { next[col] = to; changes[col] = [from, to]; } };

  if (fixes.remove_text.length) {
    if (!p.description) throw new FixError('This post has no description to cut from.');
    const cut = cutText(p.description, fixes.remove_text);
    if (cut.missing.length) throw new FixError(`These pieces are not in the description, word for word: ${cut.missing.map(m => `"${m}"`).join(', ')}.`);
    if (cut.text.length < MIN_DESCRIPTION) throw new FixError('Cutting that leaves too little of the description. Send needs_check instead.');
    put('description', p.description, cut.text);
  }
  for (const col of fixes.clear) put(col, p[col], null);

  const set = Object.entries(fixes.set);
  if (set.length) {
    if (!quote) throw new FixError('fixes.set needs evidence: a quote from the page that states the new value.');
    const q = normalizeQuote(quote);
    let start = p.start_at, end = p.end_at;
    for (const [field, value] of set) {
      if (field === 'start_date' || field === 'end_date') {
        const at = parseLondonDate(value, field === 'start_date' ? 0 : 23, field === 'start_date' ? 0 : 59);
        if (at === null) throw new FixError('Dates must look like 2026-10-03.');
        if (!dateOnPage(quote, value)) throw new FixError(`Your quote does not state ${value}. Quote the sentence that gives the ${field === 'start_date' ? 'start' : 'end'} date.`);
        if (dayDiff(at, field === 'start_date' ? p.start_at : p.end_at) > MAX_DATE_SHIFT_DAYS) throw new FixError(`${field} moves by more than ${MAX_DATE_SHIFT_DAYS} days. A person has to look.`);
        if (field === 'start_date') start = at; else end = at;
      } else {
        if (!q.includes(normalizeQuote(value))) throw new FixError(`Your quote must contain the new ${field} exactly as the page words it: "${value}".`);
        put(field, p[field as 'address' | 'price_text' | 'hours_text'], value);
      }
    }
    if (end <= start) throw new FixError('The end must be after the start.');
    if (end - start > MAX_DURATION) throw new FixError('That would run longer than a pop-up may.');
    put('start_at', p.start_at, start);
    put('end_at', p.end_at, end);
  }

  const cols = Object.keys(next);
  if (!cols.length) return {};
  const moved = await db.prepare(`UPDATE popups SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND status = ?`)
    .bind(...cols.map(c => next[c]), now, p.id, p.status).run();
  if (!moved.meta.changes) throw new FixError('The post changed while you were checking it. Check it again.');
  await log(db, agent.user_id, 'popup.agent_fix', p.id, { agent: agent.id, status: p.status, changes }, now);
  return changes;
}

export type AutoKind = 'duplicate' | 'out_of_scope' | 'cancelled';

/**
 * Takes a post out of the public list and the review queue on an agent's word: removed (duplicate, out of scope) or ended
 * (cancelled). Returns false when it was no longer in the status the agent saw. The admin can restore it, and undoAgent()
 * puts it back as it was. Open notes are settled, as they are after an admin decision.
 */
export async function autoRemove(
  db: D1Database, p: Pick<FixTarget, 'id' | 'status'>, kind: AutoKind, agent: ActingAgent,
  detail: { reason: string; merged_into?: string | null }, now: number,
): Promise<boolean> {
  const to = kind === 'cancelled' ? 'ended' : 'removed';
  const moved = await db.prepare("UPDATE popups SET status = ?, merged_into = ?, lease_agent = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = ?")
    .bind(to, detail.merged_into ?? null, now, p.id, p.status).run();
  if (!moved.meta.changes) return false;
  await db.prepare('UPDATE agent_notes SET resolved_at = ? WHERE popup_id = ? AND resolved_at IS NULL').bind(now, p.id).run();
  await log(db, agent.user_id, kind === 'cancelled' ? 'popup.agent_end' : 'popup.agent_remove', p.id, { agent: agent.id, kind, from: p.status, to, ...detail }, now);
  return true;
}
