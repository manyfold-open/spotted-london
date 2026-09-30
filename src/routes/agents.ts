import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAdmin } from '../middleware';
import { ApiError, bad, sha256 } from '../lib/util';
import { jsonBody, num, oneOf, text } from '../lib/validate';
import { randomToken } from '../lib/auth';
import { seal, unseal } from '../lib/seal';
import { checkRpcUrl, probe } from '../lib/a2a';
import { AGENT_INFO, AGENT_IDS, blocker, loadAgent, nextRunAt, SCHEDULES, startRun, type AgentRow, type RunRow } from '../db/agents';
import { audit } from './admin';

// Admin settings for the AI agents (/admin/agent in the web app). Secrets are write-only:
// the caller token and the Spotted key are never sent back, only their last four characters.

export const agentsAdmin = new Hono<AppEnv>();

export const SKILL_URL = 'https://github.com/tldr0810/spotted-london/tree/main/skills/spotted-london';

const hint = (s: string) => `…${s.slice(-4)}`;

function view(a: AgentRow, runs: RunRow[], openNotes: number) {
  const info = AGENT_INFO[a.id];
  return {
    id: a.id, name: info.name, job: info.job, unit: info.unit,
    enabled: !!a.enabled, schedule: a.schedule, run_hour: a.run_hour, instructions: a.instructions, max_items: a.max_items,
    rpc_url: a.rpc_url, token_hint: a.token_hint, key_hint: a.key_hint,
    connected: !!(a.rpc_url && a.token_sealed), next_run_at: a.enabled ? a.next_run_at : null,
    open_notes: openNotes,
    runs: runs.map(r => ({ id: r.id, trigger: r.trigger, status: r.status, summary: r.summary, error: r.error, items: r.items, started_at: r.started_at, finished_at: r.finished_at })),
  };
}

agentsAdmin.get('/', async c => {
  requireAdmin(c);
  const db = c.env.DB;
  const [{ results: agents }, { results: runs }, { results: notes }] = await Promise.all([
    db.prepare('SELECT * FROM agents').all<AgentRow>(),
    db.prepare('SELECT * FROM agent_runs WHERE started_at > ? ORDER BY started_at DESC LIMIT 100').bind(c.get('now') - 30 * 86_400_000).all<RunRow>(),
    db.prepare("SELECT agent_id, COUNT(*) AS n FROM agent_notes WHERE resolved_at IS NULL AND verdict != 'looks_real' GROUP BY agent_id").all<{ agent_id: string; n: number }>(),
  ]);
  const origin = c.env.APP_URL ? new URL(c.env.APP_URL).origin : new URL(c.req.url).origin;
  return c.json({
    mcp_url: `${origin}/mcp`,
    skill_url: SKILL_URL,
    agents_key_set: (c.env.AGENTS_KEY ?? '').length >= 32,
    agents: AGENT_IDS.map(id => agents.find(a => a.id === id)).filter((a): a is AgentRow => !!a).map(a =>
      view(a, runs.filter(r => r.agent_id === a.id).slice(0, 8), notes.find(n => n.agent_id === a.id)?.n ?? 0)),
  });
});

agentsAdmin.patch('/:id', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const db = c.env.DB;
  const a = await loadAgent(db, c.req.param('id'));
  const b = await jsonBody(c.req);
  const next: AgentRow = { ...a };
  const changed: Record<string, unknown> = {};

  if (b.schedule !== undefined) next.schedule = oneOf(b, 'schedule', SCHEDULES, { required: true })!;
  if (b.run_hour !== undefined) next.run_hour = Math.round(num(b, 'run_hour', { required: true, min: 0, max: 23 })!);
  if (b.max_items !== undefined) next.max_items = Math.round(num(b, 'max_items', { required: true, min: 1, max: 50 })!);
  if (b.instructions !== undefined) next.instructions = text(b, 'instructions', { max: 2000 });
  if (b.rpc_url !== undefined) {
    const raw = text(b, 'rpc_url', { max: 500 });
    next.rpc_url = raw ? checkRpcUrl(raw, c.env.ENVIRONMENT === 'development') : null;
  }
  if (b.token !== undefined) {
    const token = text(b, 'token', { max: 4000 });
    if (token && token.length < 16) throw bad('token_invalid', 'That does not look like a Manyfold caller token. Copy the whole token and paste it again.');
    next.token_sealed = token ? await seal(c.env.AGENTS_KEY, token) : null;
    next.token_hint = token ? hint(token) : null;
    changed.token = token ? 'replaced' : 'removed';
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw bad('enabled_invalid', 'Enabled must be true or false.');
    next.enabled = b.enabled ? 1 : 0;
  }
  if (next.enabled && !a.enabled) {
    const stop = await blocker(db, next, now);
    if (stop && stop.code !== 'agent_busy') throw stop;
  }
  for (const k of ['schedule', 'run_hour', 'max_items', 'instructions', 'rpc_url', 'enabled'] as const) {
    if (next[k] !== a[k]) changed[k] = next[k];
  }
  // A new schedule counts from now. Turning an agent off clears its next run.
  const timing = next.enabled !== a.enabled || next.schedule !== a.schedule || next.run_hour !== a.run_hour;
  if (timing) next.next_run_at = next.enabled ? nextRunAt(next, now) : null;

  await db.prepare(
    `UPDATE agents SET enabled = ?, schedule = ?, run_hour = ?, instructions = ?, max_items = ?, rpc_url = ?, token_sealed = ?, token_hint = ?,
       next_run_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(next.enabled, next.schedule, next.run_hour, next.instructions, next.max_items, next.rpc_url, next.token_sealed, next.token_hint, next.next_run_at, now, a.id).run();
  if (Object.keys(changed).length) await audit(db, admin.id, 'agent.update', 'agent', a.id, changed, now);
  return c.json(await one(db, a.id, now));
});

/** New Spotted key for the agent. Shown once; only its hash is kept. */
agentsAdmin.post('/:id/key', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const a = await loadAgent(c.env.DB, c.req.param('id'));
  const key = `spk_${randomToken(24)}`;
  await c.env.DB.prepare('UPDATE agents SET key_hash = ?, key_hint = ?, updated_at = ? WHERE id = ?').bind(await sha256(key), hint(key), now, a.id).run();
  await audit(c.env.DB, admin.id, 'agent.key_created', 'agent', a.id, { hint: hint(key) }, now);
  return c.json({ key, key_hint: hint(key) }, 201);
});

/** Revoking the key also turns the agent off, because it can no longer do anything. */
agentsAdmin.delete('/:id/key', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const a = await loadAgent(c.env.DB, c.req.param('id'));
  await c.env.DB.prepare('UPDATE agents SET key_hash = NULL, key_hint = NULL, enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?').bind(now, a.id).run();
  await audit(c.env.DB, admin.id, 'agent.key_revoked', 'agent', a.id, null, now);
  return c.json(await one(c.env.DB, a.id, now));
});

/** Checks the A2A address and token without starting a billed turn. */
agentsAdmin.post('/:id/test', async c => {
  requireAdmin(c);
  const a = await loadAgent(c.env.DB, c.req.param('id'));
  if (!a.rpc_url || !a.token_sealed) throw new ApiError(409, 'agent_not_connected', 'Paste the A2A address and caller token first.');
  await probe({ rpcUrl: a.rpc_url, token: await unseal(c.env.AGENTS_KEY, a.token_sealed) });
  return c.json({ ok: true, message: 'Connected. Manyfold accepted the token.' });
});

agentsAdmin.post('/:id/run', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const a = await loadAgent(c.env.DB, c.req.param('id'));
  const run = await startRun(c.env, a, 'manual', now);
  await audit(c.env.DB, admin.id, 'agent.run', 'agent', a.id, { run: run.id }, now);
  return c.json(await one(c.env.DB, a.id, now), 201);
});

/** The admin read an agent's note and does not need to act on it. */
agentsAdmin.post('/notes/:id/dismiss', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const r = await c.env.DB.prepare('UPDATE agent_notes SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').bind(now, c.req.param('id')).run();
  if (!r.meta.changes) throw new ApiError(404, 'not_found', 'This note does not exist or was already dismissed.');
  await audit(c.env.DB, admin.id, 'agent_note.dismiss', 'agent_note', c.req.param('id'), null, now);
  return c.json({ ok: true });
});

async function one(db: D1Database, id: string, now: number) {
  const a = await loadAgent(db, id);
  const [{ results: runs }, notes] = await Promise.all([
    db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? AND started_at > ? ORDER BY started_at DESC LIMIT 8').bind(id, now - 30 * 86_400_000).all<RunRow>(),
    db.prepare("SELECT COUNT(*) AS n FROM agent_notes WHERE agent_id = ? AND resolved_at IS NULL AND verdict != 'looks_real'").bind(id).first<{ n: number }>(),
  ]);
  return view(a, runs, notes?.n ?? 0);
}
