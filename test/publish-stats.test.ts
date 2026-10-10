import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { clearPublishStats, publishStats, STATS_TTL } from '../src/db/publish';

const NOW = Date.UTC(2026, 9, 10, 12);

async function addPublish(popupId: string, agent: string) {
  await env.DB.prepare(`INSERT INTO popups (id, slug, title, category, start_at, end_at, lat, lng, geohash, address, status, created_by, created_at, updated_at, is_example)
    VALUES (?, ?, ?, 'other', ?, ?, 51.5, -0.1, 'gcpvj', 'A', 'community', 'ps_user', ?, ?, 0)`).bind(popupId, popupId, popupId, NOW, NOW + 86_400_000, NOW, NOW).run();
  await env.DB.prepare("INSERT INTO audit_log (id, admin_id, action, target_type, target_id, detail, created_at) VALUES (?, 'ps_user', 'popup.agent_publish', 'popup', ?, ?, ?)")
    .bind(`al_${popupId}`, popupId, JSON.stringify({ agents: [agent] }), NOW).run();
}

describe('publishStats cache', () => {
  beforeAll(async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('ps_user', 'ps_user@test.dev', ?)").bind(NOW).run();
  });
  beforeEach(() => clearPublishStats());

  it('keeps the numbers for 5 minutes, unless asked for fresh ones or something was published', async () => {
    await addPublish('ps_1', 'ps_agent');
    expect((await publishStats(env.DB, NOW)).get('ps_agent')?.published).toBe(1);
    await addPublish('ps_2', 'ps_agent'); // written straight to the table: the cache does not know
    expect((await publishStats(env.DB, NOW + 60_000)).get('ps_agent')?.published).toBe(1);
    expect((await publishStats(env.DB, NOW + 60_000, true)).get('ps_agent')?.published).toBe(2);
    await addPublish('ps_3', 'ps_agent');
    expect((await publishStats(env.DB, NOW + 61_000)).get('ps_agent')?.published).toBe(2); // fresh refilled the cache
    expect((await publishStats(env.DB, NOW + 60_000 + STATS_TTL)).get('ps_agent')?.published).toBe(3); // and it expires
  });

  it('is cleared when an agent publishes or is undone', async () => {
    const { undoAgent } = await import('../src/db/publish');
    await addPublish('ps_4', 'ps_undo_agent');
    expect((await publishStats(env.DB, NOW)).get('ps_undo_agent')?.undone).toBe(0);
    await undoAgent(env.DB, { id: 'ps_undo_agent', user_id: 'ps_agent_user' }, NOW - 1000, 'ps_user', NOW);
    expect((await publishStats(env.DB, NOW + 1000)).get('ps_undo_agent')?.undone).toBe(1);
  });

  it('looks up the audit log by action through an index', async () => {
    const plan = async (sql: string) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map(r => r.detail).join(' | ');
    expect(await plan("SELECT json_extract(detail, '$.agent') AS agent_id, COUNT(*) AS n FROM audit_log WHERE action = 'popup.agent_publish_undo' GROUP BY 1")).toMatch(/idx_audit_action/);
    expect(await plan("SELECT a.target_id FROM audit_log a WHERE a.action = 'popup.agent_publish'")).toMatch(/idx_audit_action/);
  });
});
