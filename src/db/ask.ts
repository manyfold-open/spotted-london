// Ask for recommendations (docs/superpowers/specs/2026-10-08-ask-recommendations-design.md): a visitor types a request,
// a Concierge agent on Manyfold answers from the public list, and the page polls until the answer is ready.
//
// Spotted starts the agent's task when the question comes in (A2A, not waiting) and checks it with tasks/get each time
// the page polls, at most once every ASK_POLL_GAP. The agent has only the public search_popups and get_popup tools.
// Whatever it names is checked against the public list before it is stored, so a made-up pop-up never reaches anyone.
//
// Limits are counted from the asks table itself, which is exact and needs no KV writes: a visitor (salted IP hash)
// gets ASK_PER_VISITOR questions a London day, and all visitors together get dailyCap().

import type { Bindings } from '../types';
import { FINISHED, getTask, safeErrorText, startTask, type TaskInfo } from '../lib/a2a';
import { ASK_PICKS, ASK_PICKS_NEAR, askBrief, parseAnswer, type Answer, type TasteSummary } from '../lib/ask';
import { unseal } from '../lib/seal';
import { DAY } from '../lib/scoring';
import { londonParts, londonTime } from '../lib/time';
import { ApiError } from '../lib/util';
import type { AgentRow } from './agents';
import { snapshotItems } from './snapshot';

export const ASK_PER_VISITOR = 5;
/** All questions together in one London day. Each one is a model turn on Manyfold, so this is the cost lever. */
export const ASK_DAILY_CAP = 150;
/** A question that has no answer after this long fails, so the page never waits for ever. */
export const ASK_TIMEOUT = 90_000;
/** Polls closer together than this reuse the stored state instead of asking Manyfold again. */
export const ASK_POLL_GAP = 1_500;
/** Rows are kept this long (cron, 04:00). */
export const ASK_KEEP = 7 * DAY;

export interface AskRow {
  id: string;
  asked_at: number;
  ip_hash: string;
  text: string;
  taste: string | null;
  near_me: number;
  status: 'pending' | 'done' | 'failed';
  agent_id: string | null;
  task_id: string | null;
  answer: string | null;
  error: string | null;
  checked_at: number | null;
  finished_at: number | null;
}

/** ASK_DAILY_CAP unless the optional ASK_DAILY_CAP variable says otherwise. 0 switches Ask off for everyone. */
export function dailyCap(env: Pick<Bindings, 'ASK_DAILY_CAP'>): number {
  const n = Math.floor(Number(env.ASK_DAILY_CAP));
  return env.ASK_DAILY_CAP !== undefined && env.ASK_DAILY_CAP !== '' && Number.isFinite(n) && n >= 0 ? n : ASK_DAILY_CAP;
}

export function londonDayStart(now: number): number {
  const p = londonParts(now);
  return londonTime(p.y, p.m, p.d);
}

/** Questions asked since London midnight: by this visitor, and by everyone. */
export async function usage(db: D1Database, who: string, now: number): Promise<{ visitor: number; total: number }> {
  const from = londonDayStart(now);
  const [v, t] = await db.batch<{ n: number }>([
    db.prepare('SELECT COUNT(*) AS n FROM asks WHERE ip_hash = ? AND asked_at >= ?').bind(who, from),
    db.prepare('SELECT COUNT(*) AS n FROM asks WHERE asked_at >= ?').bind(from),
  ]);
  return { visitor: v.results[0]?.n ?? 0, total: t.results[0]?.n ?? 0 };
}

/** An enabled, connected Concierge. With several, questions are spread between them at random. */
export function availableAgent(db: D1Database): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE role = 'concierge' AND enabled = 1 AND rpc_url IS NOT NULL AND token_sealed IS NOT NULL ORDER BY RANDOM() LIMIT 1").first<AgentRow>();
}

export async function createAsk(db: D1Database, o: { id: string; who: string; text: string; taste: TasteSummary | null; nearMe: boolean; agentId: string; now: number }): Promise<AskRow> {
  await db.prepare('INSERT INTO asks (id, asked_at, ip_hash, text, taste, near_me, status, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(o.id, o.now, o.who, o.text, o.taste ? JSON.stringify(o.taste) : null, o.nearMe ? 1 : 0, 'pending', o.agentId).run();
  return (await loadAsk(db, o.id))!;
}

export function loadAsk(db: D1Database, id: string): Promise<AskRow | null> {
  return db.prepare('SELECT * FROM asks WHERE id = ?').bind(id).first<AskRow>();
}

async function fail(db: D1Database, ask: AskRow, why: string, now: number): Promise<AskRow> {
  await db.prepare("UPDATE asks SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(why.slice(0, 400), now, ask.id).run();
  return (await loadAsk(db, ask.id)) ?? ask;
}

/** Reads a finished task: a readable answer is stored, anything else fails the question. */
async function settle(env: Bindings, ask: AskRow, info: TaskInfo, now: number): Promise<AskRow> {
  if (info.state !== 'completed') {
    return fail(env.DB, ask, info.state === 'input-required' || info.state === 'auth-required'
      ? 'The Concierge stopped to ask a question instead of answering. Open it in Manyfold and check its instructions.'
      : `The Concierge task ended as "${info.state}".`, now);
  }
  const items = await snapshotItems(env.DB, now);
  const live = new Map<string, string>();
  for (const p of items) if (p.end_at > now) { live.set(p.id, p.id); live.set(p.slug, p.id); }
  const answer = parseAnswer(info.text, key => live.get(key) ?? null, ask.near_me ? ASK_PICKS_NEAR : ASK_PICKS);
  if (!answer) return fail(env.DB, ask, 'The Concierge answered, but not in the form Spotted can read (a JSON object with a picks list).', now);
  await env.DB.prepare("UPDATE asks SET status = 'done', answer = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(JSON.stringify(answer), now, ask.id).run();
  return (await loadAsk(env.DB, ask.id)) ?? ask;
}

/** Starts the agent on a question just stored. A failure to start fails the question; it never throws. */
export async function startAsk(env: Bindings, agent: AgentRow, ask: AskRow, taste: TasteSummary | null, now: number): Promise<AskRow> {
  try {
    const token = await unseal(env.AGENTS_KEY, agent.token_sealed!);
    const brief = askBrief({ question: ask.text, taste, nearMe: !!ask.near_me, now, appUrl: env.APP_URL, notes: agent.instructions });
    const info = await startTask({ rpcUrl: agent.rpc_url!, token }, `spotted-ask-${ask.id}`, brief, 12_000);
    await env.DB.prepare('UPDATE asks SET task_id = ?, checked_at = ? WHERE id = ?').bind(info.taskId, now, ask.id).run();
    const started = (await loadAsk(env.DB, ask.id)) ?? ask;
    return FINISHED.includes(info.state) ? settle(env, started, info, now) : started;
  } catch (e) {
    console.warn('ask could not start', ask.id, safeErrorText(e));
    return fail(env.DB, ask, e instanceof ApiError ? e.message : safeErrorText(e), now);
  }
}

/**
 * One poll: asks Manyfold how a pending question is doing, at most once every ASK_POLL_GAP however many pages poll.
 * A hiccup in Manyfold leaves the question pending; a rejected token, a task that ended badly or the timeout fails it.
 */
export async function advanceAsk(env: Bindings, ask: AskRow, now: number): Promise<AskRow> {
  if (ask.status !== 'pending') return ask;
  if (now - ask.asked_at > ASK_TIMEOUT) return fail(env.DB, ask, `No answer within ${ASK_TIMEOUT / 1000} seconds.`, now);
  if (!ask.task_id || !ask.agent_id) return ask;
  const claim = await env.DB.prepare("UPDATE asks SET checked_at = ? WHERE id = ? AND status = 'pending' AND (checked_at IS NULL OR checked_at <= ?)")
    .bind(now, ask.id, now - ASK_POLL_GAP).run();
  if (!claim.meta.changes) return ask;
  const agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(ask.agent_id).first<AgentRow>();
  if (!agent?.rpc_url || !agent.token_sealed) return fail(env.DB, ask, 'The Concierge that took this question is no longer connected.', now);
  try {
    const info = await getTask({ rpcUrl: agent.rpc_url, token: await unseal(env.AGENTS_KEY, agent.token_sealed) }, ask.task_id);
    return FINISHED.includes(info.state) ? settle(env, ask, info, now) : ask;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'agent_token_rejected') return fail(env.DB, ask, e.message, now);
    console.warn('ask check failed', ask.id, safeErrorText(e));
    return ask;
  }
}

export function answerOf(ask: AskRow): Answer | null {
  try { return ask.answer ? (JSON.parse(ask.answer) as Answer) : null; } catch { return null; }
}

/** Cron: questions are kept for a week. Does nothing before migration 0018 has been applied. */
export async function purgeAsks(db: D1Database, now: number) {
  await db.prepare('DELETE FROM asks WHERE asked_at < ?').bind(now - ASK_KEEP).run();
}

/** For the admin page: how many questions today, how many failed, and why the last one did. */
export async function askStats(env: Bindings, now: number) {
  const from = londonDayStart(now);
  try {
    const [t, f] = await env.DB.batch<{ n: number } & { error: string | null }>([
      env.DB.prepare('SELECT COUNT(*) AS n FROM asks WHERE asked_at >= ?').bind(from),
      env.DB.prepare("SELECT COUNT(*) AS n, (SELECT error FROM asks WHERE status = 'failed' AND asked_at >= ?1 ORDER BY asked_at DESC LIMIT 1) AS error FROM asks WHERE status = 'failed' AND asked_at >= ?1").bind(from),
    ]);
    return { today: t.results[0]?.n ?? 0, cap: dailyCap(env), per_visitor: ASK_PER_VISITOR, failed_today: f.results[0]?.n ?? 0, last_error: f.results[0]?.error ?? null };
  } catch {
    return null; // migration 0018 not applied yet
  }
}
