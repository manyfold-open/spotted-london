import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_LABELS, isCategory } from '../src/shared/categories';

const NEW_KEYS = ['food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other'];

const insertPopup = (id: string, category: string) => env.DB.prepare(
  `INSERT INTO popups (id, slug, title, category, lat, lng, geohash, start_at, end_at, created_by, created_at, updated_at)
   VALUES (?, ?, 'Test', ?, 51.5, -0.1, 'gcpvj', 1, 2, 'cat_user', 1, 1)`,
).bind(id, id, category).run();

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, role, created_at) VALUES ('cat_user', 'cat_user@test.dev', 'user', 1)").run();
});
afterEach(async () => {
  for (const t of ['votes', 'popup_images', 'saves']) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE popup_id LIKE 'cat\\_%' ESCAPE '\\'`).run();
  }
  await env.DB.prepare("DELETE FROM popups WHERE id LIKE 'cat\\_%' ESCAPE '\\'").run();
  await env.DB.prepare("DELETE FROM users WHERE id = 'cat_user2'").run();
});

describe('popups schema after 0014', () => {
  it('accepts every category and rejects anything else', async () => {
    for (const c of NEW_KEYS) await insertPopup(`cat_${c}`, c);
    await expect(insertPopup('cat_rave', 'rave')).rejects.toThrow();
  });

  it('keeps foreign keys intact and still refers to popups by its own name', async () => {
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const stale = await env.DB.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%popups_new%' OR sql LIKE '%popups_old%' OR sql LIKE '%popups_park%'").all();
    expect(stale.results).toEqual([]);
  });

  it('keeps the four list, geo and user indexes', async () => {
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'popups' AND name LIKE 'idx_%' ORDER BY name").all<{ name: string }>();
    expect(idx.results.map(r => r.name)).toEqual(['idx_popups_box', 'idx_popups_geo', 'idx_popups_list', 'idx_popups_user']);
  });

  it('keeps the columns added by later migrations', async () => {
    const cols = (await env.DB.prepare('PRAGMA table_info(popups)').all<{ name: string }>()).results.map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['is_example', 'evidence', 'evidence_url', 'evidence_check', 'lease_agent', 'lease_until', 'tags', 'date_kind', 'date_ranges']));
    expect(cols).toHaveLength(41);
  });
});

describe('migration 0014 on a database that already holds child rows', () => {
  it('rebuilds popups without losing rows, links, children or indexes', async () => {
    const m = env.TEST_MIGRATIONS.find(x => x.name.includes('0014_categories'))!;
    expect(m).toBeDefined();
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, role, created_at) VALUES ('cat_user2', 'cat_user2@test.dev', 'user', 1)").run();
    await insertPopup('cat_parent', 'dining');
    await insertPopup('cat_dupe', 'art');
    await env.DB.prepare("UPDATE popups SET merged_into = 'cat_parent' WHERE id = 'cat_dupe'").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO votes (user_id, popup_id, kind, value, weight, created_at) VALUES ('cat_user', 'cat_parent', 'existence', 1, 1, 1)"),
      env.DB.prepare("INSERT INTO votes (user_id, popup_id, kind, value, weight, created_at) VALUES ('cat_user2', 'cat_parent', 'quality', -1, 1, 1)"),
      env.DB.prepare("INSERT INTO popup_images (id, popup_id, r2_key, position, uploaded_by, created_at) VALUES ('cat_img1', 'cat_parent', 'k1', 0, 'cat_user', 1)"),
      env.DB.prepare("INSERT INTO popup_images (id, popup_id, r2_key, position, uploaded_by, created_at) VALUES ('cat_img2', 'cat_parent', 'k2', 1, 'cat_user2', 1)"),
      env.DB.prepare("INSERT INTO saves (user_id, popup_id, created_at) VALUES ('cat_user', 'cat_parent', 1)"),
      env.DB.prepare("INSERT INTO saves (user_id, popup_id, created_at) VALUES ('cat_user2', 'cat_parent', 1)"),
    ]);

    await env.DB.batch(m.queries.map(q => env.DB.prepare(q)));

    const popups = await env.DB.prepare("SELECT id, category, merged_into FROM popups WHERE id LIKE 'cat\\_%' ESCAPE '\\' ORDER BY id").all();
    expect(popups.results).toEqual([
      { id: 'cat_dupe', category: 'art', merged_into: 'cat_parent' },
      { id: 'cat_parent', category: 'dining', merged_into: null },
    ]);
    const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE popup_id = 'cat_parent'`).first<{ n: number }>())!.n;
    expect(await count('votes')).toBe(2);
    expect(await count('popup_images')).toBe(2);
    expect(await count('saves')).toBe(2);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'popups' AND name LIKE 'idx_%' ORDER BY name").all<{ name: string }>();
    expect(idx.results.map(r => r.name)).toEqual(['idx_popups_box', 'idx_popups_geo', 'idx_popups_list', 'idx_popups_user']);
    const leftovers = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('popups_park', 'popups_new')").all();
    expect(leftovers.results).toEqual([]);
  });
});

describe('shared category list', () => {
  it('has the eleven keys in chip order', () => {
    expect([...CATEGORIES]).toEqual(NEW_KEYS);
  });

  it('gives every key one unique label with no dashes', () => {
    expect(Object.keys(CATEGORY_LABELS)).toEqual([...CATEGORIES]);
    const labels = Object.values(CATEGORY_LABELS);
    expect(new Set(labels).size).toBe(CATEGORIES.length);
    for (const l of labels) expect(l).not.toMatch(/[–—]| - /);
  });

  it('isCategory accepts keys and nothing else', () => {
    expect(isCategory('dining')).toBe(true);
    expect(isCategory('rave')).toBe(false);
    expect(isCategory('')).toBe(false);
  });

  it('matches the CHECK in the live popups table, so the two cannot drift apart', async () => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'popups'").first<{ sql: string }>();
    const m = row!.sql.match(/category TEXT NOT NULL CHECK \(category IN \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const inDb = m![1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect([...inDb].sort()).toEqual([...CATEGORIES].sort());
  });
});
