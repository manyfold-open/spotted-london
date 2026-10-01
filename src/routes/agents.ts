import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAdmin } from '../middleware';
import { ApiError, bad, newId, sha256 } from '../lib/util';
import { jsonBody, num, oneOf, text } from '../lib/validate';
import { randomToken } from '../lib/auth';
import { seal, unseal } from '../lib/seal';
import { checkRpcUrl, probe } from '../lib/a2a';
import { connectPoll, connectStart } from '../lib/manyfold';
import { AGENT_INFO, AGENT_IDS, blocker, loadAgent, nextRunAt, SCHEDULES, startRun, type AgentRow, type RunRow } from '../db/agents';
import { audit } from './admin';
import { nextDue, SOURCE_KINDS, SOURCE_STATUSES, sourceStats, sourceTarget, type SourceRow } from '../db/scout';
import { lastRuns, newPostCounts, socialSummary } from '../db/social';
import { socialMode } from '../lib/social';

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

/*
 * Connect with Manyfold (device-code sign-in, see src/lib/manyfold.ts). The device code is the
 * secret that redeems the token, so it stays on the server: sealed in KV for the 15 minutes
 * Manyfold keeps the request open. The browser only sees the link and the code to compare.
 */
const CONNECT_TTL = 15 * 60;
const connectKey = (id: string) => `mf-connect:${id}`;

agentsAdmin.post('/:id/connect', async c => {
  requireAdmin(c);
  const a = await loadAgent(c.env.DB, c.req.param('id'));
  // Fail before Manyfold hands out anything we could not store.
  await seal(c.env.AGENTS_KEY, 'check');
  const app = c.env.APP_URL ? new URL(c.env.APP_URL) : null;
  const start = await connectStart(c.env.MANYFOLD_API_URL, `Spotted London (${AGENT_INFO[a.id].name})`, app?.protocol === 'https:' ? app.origin : null);
  await c.env.CACHE.put(connectKey(a.id), await seal(c.env.AGENTS_KEY, start.deviceCode), { expirationTtl: CONNECT_TTL });
  return c.json({ auth_url: start.authUrl, user_code: start.userCode, expires_at: Date.parse(start.expiresAt) || c.get('now') + CONNECT_TTL * 1000 }, 201);
});

agentsAdmin.post('/:id/connect/poll', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const db = c.env.DB;
  const a = await loadAgent(db, c.req.param('id'));
  const sealed = await c.env.CACHE.get(connectKey(a.id));
  if (!sealed) return c.json({ status: 'expired' });
  const r = await connectPoll(c.env.MANYFOLD_API_URL, await unseal(c.env.AGENTS_KEY, sealed));
  if (r.status === 'pending') return c.json({ status: 'pending' });
  await c.env.CACHE.delete(connectKey(a.id));
  if (r.status !== 'approved') return c.json({ status: r.status });

  // One Spotted agent maps to one Manyfold agent. Extra approvals are not stored.
  const got = r.agents[0];
  if (!got) return c.json({ status: 'denied' });
  const rpcUrl = checkRpcUrl(got.rpcUrl, c.env.ENVIRONMENT === 'development');
  await db.prepare('UPDATE agents SET rpc_url = ?, token_sealed = ?, token_hint = ?, updated_at = ? WHERE id = ?')
    .bind(rpcUrl, await seal(c.env.AGENTS_KEY, got.token), hint(got.token), now, a.id).run();
  await audit(db, admin.id, 'agent.connected', 'agent', a.id, { manyfold_agent: got.agentId, name: got.name, expires_at: got.expiresAt, ignored: r.agents.length - 1 }, now);
  return c.json({ status: 'approved', manyfold_agent: got.name, ignored: r.agents.length - 1, token_expires_at: got.expiresAt ? Date.parse(got.expiresAt) : null, agent: await one(db, a.id, now) });
});

/** Checks the A2A address and token without starting a billed turn. */
agentsAdmin.post('/:id/test', async c => {
  requireAdmin(c);
  const a = await loadAgent(c.env.DB, c.req.param('id'));
  if (!a.rpc_url || !a.token_sealed) throw new ApiError(409, 'agent_not_connected', 'Connect this agent first: press Connect with Manyfold.');
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

/* ---------- Scout's sources ---------- */

async function sourceView(db: D1Database, rows: SourceRow[], now: number) {
  const stats = await sourceStats(db, rows.map(r => r.id));
  const socialIds = rows.filter(r => r.kind === 'social').map(r => r.id);
  const [fresh, runs] = await Promise.all([newPostCounts(db, socialIds, now), lastRuns(db, socialIds)]);
  return rows.map(r => {
    const mode = r.kind === 'social' ? socialMode(r.target) : null;
    const run = runs.get(r.id);
    return {
      id: r.id, kind: r.kind, target: r.target, label: r.label, status: r.status, every_days: r.every_days, note: r.note,
      suggested_by_run: r.suggested_by_run, last_checked_at: r.last_checked_at, due_at: r.due_at, created_at: r.created_at,
      track_record: stats.get(r.id) ?? { drafts: 0, published: 0, rejected: 0, waiting: 0 },
      ...(r.kind === 'social' ? {
        fetch: {
          mode: mode?.label ?? null,
          fetchable: !!mode,
          new_posts: fresh.get(r.id) ?? 0,
          last_run: run ? { status: run.status, at: run.started_at, items: run.items, kept: run.kept, cost_usd: Math.round(run.cost_usd * 1000) / 1000, error: run.error } : null,
        },
      } : {}),
    };
  });
}

/** Every source, suggestions from Scout first. */
agentsAdmin.get('/sources', async c => {
  requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM scout_sources ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, kind, label",
  ).all<SourceRow>();
  const now = c.get('now');
  return c.json({
    sources: await sourceView(c.env.DB, results, now),
    apify: await socialSummary(c.env.DB, !!c.env.APIFY_TOKEN, now),
  });
});

agentsAdmin.post('/sources', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const db = c.env.DB;
  const b = await jsonBody(c.req);
  const kind = oneOf(b, 'kind', SOURCE_KINDS, { required: true })!;
  const target = sourceTarget(kind, text(b, 'target', { max: 500, required: true })!);
  if (!target) throw bad('target_invalid', kind === 'search' ? 'Type the words to search for.' : 'The address must be a public web address, like https://www.example.com/events.');
  if (await db.prepare('SELECT 1 FROM scout_sources WHERE target = ?').bind(target).first()) throw new ApiError(409, 'source_exists', 'This source is already on the list.');
  const id = `src_${newId()}`;
  await db.prepare("INSERT INTO scout_sources (id, kind, target, label, status, every_days, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)")
    .bind(id, kind, target, text(b, 'label', { max: 80, required: true }), Math.round(num(b, 'every_days', { min: 1, max: 60 }) ?? 1), text(b, 'note', { max: 300 }), now, now).run();
  await audit(db, admin.id, 'scout_source.add', 'scout_source', id, { kind, target }, now);
  const row = await db.prepare('SELECT * FROM scout_sources WHERE id = ?').bind(id).first<SourceRow>();
  return c.json((await sourceView(db, [row!], now))[0], 201);
});

/** Turn a source on or off (a suggestion goes live by setting it active), or change how often it is checked. */
agentsAdmin.patch('/sources/:id', async c => {
  const admin = requireAdmin(c);
  const now = c.get('now');
  const db = c.env.DB;
  const src = await db.prepare('SELECT * FROM scout_sources WHERE id = ?').bind(c.req.param('id')).first<SourceRow>();
  if (!src) throw new ApiError(404, 'not_found', 'There is no source with that id.');
  const b = await jsonBody(c.req);
  const status = oneOf(b, 'status', SOURCE_STATUSES) ?? src.status;
  const every = num(b, 'every_days', { min: 1, max: 60 });
  const everyDays = every === null ? src.every_days : Math.round(every);
  const label = text(b, 'label', { max: 80 }) ?? src.label;
  const note = 'note' in b ? text(b, 'note', { max: 300 }) : src.note;
  // A new interval counts from the last check; a source that was never checked stays due now.
  const due = src.last_checked_at === null ? null : nextDue(everyDays, src.last_checked_at);
  await db.prepare('UPDATE scout_sources SET status = ?, every_days = ?, label = ?, note = ?, due_at = ?, updated_at = ? WHERE id = ?')
    .bind(status, everyDays, label, note, due, now, src.id).run();
  await audit(db, admin.id, 'scout_source.update', 'scout_source', src.id, { from: src.status, status, every_days: everyDays }, now);
  const row = await db.prepare('SELECT * FROM scout_sources WHERE id = ?').bind(src.id).first<SourceRow>();
  return c.json((await sourceView(db, [row!], now))[0]);
});
