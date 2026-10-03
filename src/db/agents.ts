// AI agents on Manyfold (SPEC §13.4): what each one does, when it runs, and the run life cycle.
// Spotted only starts runs and records what comes back. The agents do their work through the
// MCP endpoint (src/mcp.ts) with their own key, and can only write drafts and notes.

import type { Bindings } from '../types';
import { FINISHED, getTask, safeErrorText, startTask, type TaskInfo } from '../lib/a2a';
import { unseal } from '../lib/seal';
import { HOUR } from '../lib/scoring';
import { londonParts, nextLondonSlot } from '../lib/time';
import { ApiError, newId, sha256 } from '../lib/util';

/** What an agent does. Each role can have many agents; the first of each is named after its role. */
export type AgentRole = 'scout' | 'triage' | 'checker';
export type Schedule = 'hourly' | 'every_6h' | 'daily' | 'weekly' | 'manual';
export const AGENT_ROLES: AgentRole[] = ['scout', 'triage', 'checker'];
export const AGENTS_PER_ROLE_MAX = 20;
export const SCHEDULES: Schedule[] = ['hourly', 'every_6h', 'daily', 'weekly', 'manual'];

export interface AgentRow {
  id: string;
  role: AgentRole;
  name: string;
  user_id: string;
  enabled: number;
  schedule: Schedule;
  run_hour: number;
  instructions: string | null;
  max_items: number;
  rpc_url: string | null;
  token_sealed: string | null;
  token_hint: string | null;
  key_hash: string | null;
  key_hint: string | null;
  next_run_at: number | null;
  updated_at: number;
  created_at: number;
  /** 1 when a Manyfold automation starts this agent at its schedule and Spotted is only the backup. */
  manyfold_scheduled: number;
}

export interface RunRow {
  id: string;
  agent_id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'done' | 'failed';
  task_id: string | null;
  summary: string | null;
  error: string | null;
  items: number;
  started_at: number;
  finished_at: number | null;
  checked_at: number | null;
  /** How the run began: 'manyfold' (start_run), 'fallback' (Spotted, after the wait), or null (Spotted's own schedule or Run now). */
  via: string | null;
}

/** An agent scheduled on Manyfold gets this long to start; then Spotted starts it, unless a run began near its slot. */
export const BACKUP_GRACE = 30 * 60_000;
/** A run that began this long before the slot, or later, counts as the slot's run. */
const BACKUP_EARLY = 20 * 60_000;

/** A run that has not finished after this long is marked failed. */
export const RUN_TIMEOUT = 3 * HOUR;

export const AGENT_INFO: Record<AgentRole, { name: string; job: string; unit: string; tools: string[] }> = {
  scout: {
    name: 'Scout',
    job: 'Finds new London pop-ups on the web and sends them in as drafts. Every draft waits in the review queue for you.',
    unit: 'drafts',
    tools: ['start_run', 'list_sources', 'get_social_posts', 'check_seen', 'find_place', 'check_duplicates', 'submit_draft', 'skip_url', 'mark_source_checked', 'suggest_source', 'finish_run'],
  },
  triage: {
    name: 'Triage',
    job: 'Checks each post waiting for review against its source on its own, and leaves you a note: looks real, needs a check, likely fake or duplicate. A post it confirmed with its own quote is marked ready to publish.',
    unit: 'notes',
    tools: ['start_run', 'list_review_queue', 'check_duplicates', 'add_note', 'finish_run'],
  },
  checker: {
    name: 'Checker',
    job: 'Rechecks live pop-ups against their source links and flags the ones that were cancelled or changed dates or place.',
    unit: 'notes',
    tools: ['start_run', 'list_live_popups', 'add_note', 'finish_run'],
  },
};

export async function loadAgent(db: D1Database, id: string): Promise<AgentRow> {
  const a = await db.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first<AgentRow>();
  if (!a) throw new ApiError(404, 'not_found', 'There is no agent with that name.');
  return a;
}

export async function agentByKey(db: D1Database, key: string): Promise<AgentRow | null> {
  if (!key.startsWith('spk_')) return null;
  return db.prepare('SELECT * FROM agents WHERE key_hash = ?').bind(await sha256(key)).first<AgentRow>();
}

/** Next scheduled start after `from`, in London time. Weekly runs are on Mondays. */
export function nextRunAt(a: Pick<AgentRow, 'schedule' | 'run_hour'>, from: number): number | null {
  switch (a.schedule) {
    case 'hourly': return nextLondonSlot(from, Array.from({ length: 24 }, (_, h) => h));
    case 'every_6h': return nextLondonSlot(from, [0, 6, 12, 18].map(h => (h + a.run_hour) % 24).sort((x, y) => x - y));
    case 'daily': return nextLondonSlot(from, [a.run_hour]);
    case 'weekly': return nextLondonSlot(from, [a.run_hour], [1]);
    default: return null;
  }
}

/** The message that starts a run. The skill installed on the agent explains each step. */
export function brief(a: AgentRow, runId: string, appUrl: string, now: number): string {
  const info = AGENT_INFO[a.role];
  const p = londonParts(now);
  const today = new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return [
    `Spotted London: ${info.name} run ${runId}${a.name !== info.name ? ` (${a.name})` : ''}.`,
    `Today in London is ${today}, ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}.`,
    `Use the spotted-london skill, section "${info.name}". Use the Spotted tools from the MCP server named "spotted" (${new URL('/mcp', appUrl)}), which already carries your key.`,
    `Your job: ${info.job}`,
    `Write at most ${a.max_items} ${info.unit} in this run. Pass run_id "${runId}" to every tool that asks for it.`,
    'When you are done, call finish_run with a short summary: what you looked at, what you sent, and anything the admin should know.',
    a.instructions ? `Notes from the admin:\n${a.instructions}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Why an agent cannot start a run right now, or null when it can. */
export async function blocker(db: D1Database, a: AgentRow, now: number): Promise<ApiError | null> {
  if (!a.rpc_url || !a.token_sealed) return new ApiError(409, 'agent_not_connected', 'Connect this agent first: open Connection and press Connect with Manyfold.');
  if (!a.key_hash) return new ApiError(409, 'agent_key_missing', 'Create a Spotted key for this agent first, and add it to the agent in Manyfold with mf mcp add (see Set up an agent).');
  const open = await db.prepare("SELECT id FROM agent_runs WHERE agent_id = ? AND status = 'running' AND started_at > ?").bind(a.id, now - RUN_TIMEOUT).first();
  if (open) return new ApiError(409, 'agent_busy', 'This agent is still working on its last run. Wait for it to finish, then try again.');
  return null;
}

/** Starts a run on Manyfold. The run is recorded first, so a failure to start is visible too. */
export async function startRun(env: Bindings, a: AgentRow, trigger: RunRow['trigger'], now: number, via: string | null = null): Promise<RunRow> {
  const db = env.DB;
  const stop = await blocker(db, a, now);
  if (stop) throw stop;
  const token = await unseal(env.AGENTS_KEY, a.token_sealed!);
  const id = newId();
  await db.prepare("INSERT INTO agent_runs (id, agent_id, trigger, status, started_at, via) VALUES (?, ?, ?, 'running', ?, ?)").bind(id, a.id, trigger, now, via).run();
  try {
    const info = await startTask({ rpcUrl: a.rpc_url!, token }, `spotted-run-${id}`, brief(a, id, env.APP_URL, now));
    await db.prepare('UPDATE agent_runs SET task_id = ?, checked_at = ? WHERE id = ?').bind(info.taskId, now, id).run();
    if (FINISHED.includes(info.state)) await settle(db, id, info, now);
  } catch (e) {
    await db.prepare("UPDATE agent_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .bind(e instanceof ApiError ? e.message : safeErrorText(e), now, id).run();
    throw e;
  }
  return (await db.prepare('SELECT * FROM agent_runs WHERE id = ?').bind(id).first<RunRow>())!;
}

/** Records how a finished Manyfold task ended. A summary sent with finish_run is kept. */
async function settle(db: D1Database, runId: string, info: TaskInfo, now: number) {
  // A finished turn counts as done when the agent reported back with finish_run. Without it, the agent either
  // could not use Spotted (a wrong key, a missing MCP server: no work was recorded, so the run failed) or it
  // did the work and forgot to close the run (items were recorded: the run is done, with a warning).
  const reported = await db.prepare("SELECT status, items FROM agent_runs WHERE id = ?").bind(runId).first<{ status: string; items: number }>();
  const closed = info.state === 'completed' && reported?.status !== 'running';
  const unclosed = info.state === 'completed' && reported?.status === 'running' && (reported.items ?? 0) > 0;
  const ok = closed || unclosed;
  const error = closed ? null
    : unclosed ? 'The agent did not call finish_run, so the summary below is its last message. What it sent to Spotted was saved.'
    : info.state === 'completed' ? 'The agent finished without reporting back to Spotted, so it probably could not use its Spotted tools. Read its message below.'
    : info.state === 'input-required' ? 'The agent stopped to ask a question. Answer it in Manyfold, or add the answer to its instructions here.'
    : `The agent run ended as "${info.state}".`;
  await db.prepare(
    `UPDATE agent_runs SET status = CASE WHEN status = 'running' THEN ? ELSE status END,
       summary = COALESCE(summary, ?), error = CASE WHEN status = 'running' THEN COALESCE(error, ?) ELSE error END, finished_at = COALESCE(finished_at, ?), checked_at = ? WHERE id = ?`,
  ).bind(ok ? 'done' : 'failed', info.text.slice(0, 4000) || null, error, now, now, runId).run();
}

/** Cron: asks Manyfold how open runs are doing, and gives up on runs that hang. */
export async function checkRuns(env: Bindings, now: number): Promise<void> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT r.id, r.task_id, r.started_at, a.rpc_url, a.token_sealed FROM agent_runs r JOIN agents a ON a.id = r.agent_id
     WHERE r.status = 'running' ORDER BY r.started_at LIMIT 10`,
  ).all<{ id: string; task_id: string | null; started_at: number; rpc_url: string | null; token_sealed: string | null }>();
  for (const r of results) {
    if (r.started_at < now - RUN_TIMEOUT) {
      await db.prepare("UPDATE agent_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .bind('The run did not finish within 3 hours. Check the agent in Manyfold.', now, r.id).run();
      continue;
    }
    if (!r.task_id || !r.rpc_url || !r.token_sealed) continue;
    try {
      const info = await getTask({ rpcUrl: r.rpc_url, token: await unseal(env.AGENTS_KEY, r.token_sealed) }, r.task_id);
      if (FINISHED.includes(info.state)) await settle(db, r.id, info, now);
      else await db.prepare('UPDATE agent_runs SET checked_at = ? WHERE id = ?').bind(now, r.id).run();
    } catch (e) {
      console.warn('agent run check failed', r.id, safeErrorText(e));
    }
  }
}

/**
 * Cron: starts every enabled agent whose scheduled time has come. An agent scheduled on Manyfold is
 * only a backup here: Spotted waits BACKUP_GRACE past the slot and starts it only if no run began near
 * the slot, which happens when Manyfold could not wake the agent's sandbox.
 */
export async function dispatchDue(env: Bindings, now: number): Promise<void> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM agents WHERE enabled = 1 AND schedule != 'manual' AND next_run_at IS NOT NULL
       AND next_run_at + CASE manyfold_scheduled WHEN 1 THEN ? ELSE 0 END <= ?`,
  ).bind(BACKUP_GRACE, now).all<AgentRow>();
  for (const a of results) {
    // Claim the slot first so two overlapping cron runs cannot start the same agent twice.
    const claim = await db.prepare('UPDATE agents SET next_run_at = ? WHERE id = ? AND next_run_at = ?').bind(nextRunAt(a, now), a.id, a.next_run_at).run();
    if (!claim.meta.changes) continue;
    if (a.manyfold_scheduled) {
      const began = await db.prepare('SELECT 1 FROM agent_runs WHERE agent_id = ? AND started_at >= ?').bind(a.id, a.next_run_at! - BACKUP_EARLY).first();
      if (began) continue;
    }
    const stop = await blocker(db, a, now);
    if (stop) {
      // A busy agent just skips this slot. Anything else is recorded so the admin sees why.
      if (stop.code !== 'agent_busy') {
        await db.prepare("INSERT INTO agent_runs (id, agent_id, trigger, status, error, started_at, finished_at, via) VALUES (?, ?, 'schedule', 'failed', ?, ?, ?, ?)")
          .bind(newId(), a.id, stop.message, now, now, a.manyfold_scheduled ? 'fallback' : null).run();
      }
      continue;
    }
    await startRun(env, a, 'schedule', now, a.manyfold_scheduled ? 'fallback' : null).catch(e => console.warn('agent run failed to start', a.id, safeErrorText(e)));
  }
}

export async function runAgents(env: Bindings, now: number): Promise<void> {
  await checkRuns(env, now);
  await dispatchDue(env, now);
}
