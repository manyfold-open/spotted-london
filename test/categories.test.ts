import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const NEW_KEYS = ['food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other'];

const insertPopup = (id: string, category: string) => env.DB.prepare(
  `INSERT INTO popups (id, slug, title, category, lat, lng, geohash, start_at, end_at, created_by, created_at, updated_at)
   VALUES (?, ?, 'Test', ?, 51.5, -0.1, 'gcpvj', 1, 2, 'cat_user', 1, 1)`,
).bind(id, id, category).run();

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, role, created_at) VALUES ('cat_user', 'cat_user@test.dev', 'user', 1)").run();
});
afterEach(async () => {
  await env.DB.prepare("DELETE FROM popups WHERE id LIKE 'cat\\_%' ESCAPE '\\'").run();
});

describe('popups schema after 0014', () => {
  it('accepts every category and rejects anything else', async () => {
    for (const c of NEW_KEYS) await insertPopup(`cat_${c}`, c);
    await expect(insertPopup('cat_rave', 'rave')).rejects.toThrow();
  });

  it('keeps foreign keys intact and still refers to popups by its own name', async () => {
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const stale = await env.DB.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%popups_new%' OR sql LIKE '%popups_old%'").all();
    expect(stale.results).toEqual([]);
  });

  it('keeps the four list, geo and user indexes', async () => {
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'popups' AND name LIKE 'idx_%' ORDER BY name").all<{ name: string }>();
    expect(idx.results.map(r => r.name)).toEqual(['idx_popups_box', 'idx_popups_geo', 'idx_popups_list', 'idx_popups_user']);
  });

  it('keeps the columns added by later migrations', async () => {
    const cols = (await env.DB.prepare('PRAGMA table_info(popups)').all<{ name: string }>()).results.map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['is_example', 'evidence', 'evidence_url', 'evidence_check', 'lease_agent', 'lease_until']));
    expect(cols).toHaveLength(38);
  });
});
