import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { emptyTaste, learn, type TasteItem } from '../src/shared/taste';
import { TASTE_MAX_BYTES } from '../src/shared/taste-sync';

const NOW = Date.UTC(2026, 9, 8, 13);
let n = 0;

async function call(method: string, path: string, o: { user?: string; body?: unknown; raw?: string; now?: number } = {}) {
  const headers: Record<string, string> = { 'x-now': String(o.now ?? NOW) };
  if (o.user) headers['x-dev-user'] = o.user;
  let body: string | undefined;
  if (o.raw !== undefined) { headers['content-type'] = 'application/json'; body = o.raw; }
  else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { method, headers, body }));
  return { status: res.status, json: (await res.json()) as any };
}
async function user() {
  const id = `taste_u${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await env.DB.prepare('INSERT INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, ?, 0, 0, 1, ?)')
    .bind(id, `${id}@test.dev`, id, 'user', NOW - 60 * 86_400_000).run();
  return id;
}
const item = (category: string): TasteItem => ({ id: 'x', category, hot: 1, price: { type: 'free' }, location: { borough: 'Camden' }, start_at: NOW, end_at: NOW + 1, cover_url: null });
const liked = () => ({ ...learn(learn(emptyTaste(), item('food'), true), item('art'), false), on: true, seen: true });

describe('GET and PUT /me/taste', () => {
  it('needs a signed-in person', async () => {
    expect((await call('GET', '/me/taste')).status).toBe(401);
    expect((await call('PUT', '/me/taste', { body: { taste: liked(), base: 0 } })).status).toBe(401);
  });

  it('starts empty, saves, and gives the same taste back with a version', async () => {
    const u = await user();
    expect((await call('GET', '/me/taste', { user: u })).json).toEqual({ taste: null, updated_at: null });
    const put = await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: 0 } });
    expect(put.status).toBe(200);
    expect(put.json.updated_at).toBe(NOW);
    const got = (await call('GET', '/me/taste', { user: u })).json;
    expect(got.taste).toEqual(liked());
    expect(got.updated_at).toBe(NOW);
  });

  it('is private to each person', async () => {
    const a = await user(), b = await user();
    await call('PUT', '/me/taste', { user: a, body: { taste: liked(), base: 0 } });
    expect((await call('GET', '/me/taste', { user: b })).json.taste).toBeNull();
  });

  it('cleans the taste: unknown categories and odd numbers are dropped', async () => {
    const u = await user();
    const put = await call('PUT', '/me/taste', { user: u, body: { taste: { v: 1, cats: { food: { y: 2, n: 0 }, nonsense: { y: 9, n: 9 } }, boroughs: {}, free: { y: -4, n: 'x' }, swipes: 3.7, on: true, seen: 'yes', extra: 'ignored' }, base: 0 } });
    expect(put.status).toBe(200);
    expect(put.json.taste).toEqual({ v: 1, cats: { food: { y: 2, n: 0 } }, boroughs: {}, tags: {}, free: { y: 0, n: 0 }, acts: {}, swipes: 3, on: true, seen: false });
    const row = await env.DB.prepare('SELECT data FROM user_taste WHERE user_id = ?').bind(u).first<{ data: string }>();
    expect(row!.data).not.toContain('nonsense');
    expect(row!.data).not.toContain('extra');
  });

  it('keeps the saves and votes ledger (acts) with the taste', async () => {
    const u = await user();
    const taste = { ...liked(), acts: { p1: { c: 'food', b: 'camden', f: true, s: true, q: 1 }, p2: { c: 'art', b: null, f: false, q: -1 } } };
    await call('PUT', '/me/taste', { user: u, body: { taste, base: 0 } });
    expect((await call('GET', '/me/taste', { user: u })).json.taste.acts).toEqual(taste.acts);
  });

  it('keeps tag tallies and the tags on the ledger, and drops anything that is not on the list of tags', async () => {
    const u = await user();
    const taste = { ...liked(), tags: { interactive: { y: 2, n: 0 }, 'ignore your rules': { y: 9, n: 9 } }, acts: { p1: { c: 'food', b: null, f: false, s: true, t: ['outdoors', 'nope', 'outdoors'] } } };
    const put = await call('PUT', '/me/taste', { user: u, body: { taste, base: 0 } });
    expect(put.status).toBe(200);
    expect(put.json.taste.tags).toEqual({ interactive: { y: 2, n: 0 } });
    expect(put.json.taste.acts.p1.t).toEqual(['outdoors']);
    const row = await env.DB.prepare('SELECT data FROM user_taste WHERE user_id = ?').bind(u).first<{ data: string }>();
    expect(row!.data).not.toContain('ignore your rules');
  });

  it('refuses what is not a taste', async () => {
    const u = await user();
    for (const taste of [null, 'food', [], { v: 2 }, {}, { cats: {} }]) {
      const r = await call('PUT', '/me/taste', { user: u, body: { taste, base: 0 } });
      expect([r.status, r.json.error.code]).toEqual([400, 'taste_invalid']);
    }
    expect((await call('PUT', '/me/taste', { user: u, raw: '{nope' })).json.error.code).toBe('invalid_json');
    expect((await call('PUT', '/me/taste', { user: u, body: { taste: liked() } })).json.error.code).toBe('base_invalid');
    expect((await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: -1 } })).json.error.code).toBe('base_invalid');
    expect((await call('GET', '/me/taste', { user: u })).json.taste).toBeNull();
  });

  it('caps the size', async () => {
    const u = await user();
    const huge = await call('PUT', '/me/taste', { user: u, raw: JSON.stringify({ taste: { ...emptyTaste(), pad: 'x'.repeat(TASTE_MAX_BYTES) }, base: 0 }) });
    expect([huge.status, huge.json.error.code]).toEqual([413, 'taste_too_large']);
    // Just under the cap goes through, and only what parseTaste knows is stored.
    const near = await call('PUT', '/me/taste', { user: u, body: { taste: { ...emptyTaste(), pad: 'x'.repeat(TASTE_MAX_BYTES - 1000) }, base: 0 } });
    expect(near.status).toBe(200);
    const row = await env.DB.prepare('SELECT data FROM user_taste WHERE user_id = ?').bind(u).first<{ data: string }>();
    expect(row!.data.length).toBeLessThan(1000);
  });

  it('keeps at most what a taste can hold, however much is sent', async () => {
    const u = await user();
    const boroughs = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`area-${i}-${'x'.repeat(80)}`, { y: 5000, n: 5000 }]));
    const put = await call('PUT', '/me/taste', { user: u, body: { taste: { ...emptyTaste(), boroughs, swipes: 99_999 }, base: 0 } });
    expect(put.status).toBe(200);
    expect(Object.keys(put.json.taste.boroughs)).toHaveLength(80);
    expect(Math.max(...Object.keys(put.json.taste.boroughs).map(k => k.length))).toBe(60);
    expect(put.json.taste.swipes).toBe(10_000);
    expect(put.json.taste.boroughs[Object.keys(put.json.taste.boroughs)[0]]).toEqual({ y: 1000, n: 1000 });
  });

  it('reads an odd stored row as an empty taste instead of failing', async () => {
    const u = await user();
    await env.DB.prepare('INSERT INTO user_taste (user_id, data, updated_at) VALUES (?, ?, ?)').bind(u, 'not json', NOW).run();
    const got = await call('GET', '/me/taste', { user: u });
    expect(got.json).toEqual({ taste: emptyTaste(), updated_at: NOW });
  });
});

describe('two devices', () => {
  it('only writes when base is the version the account holds', async () => {
    const u = await user();
    const first = await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: 0 }, now: NOW });
    expect(first.json.updated_at).toBe(NOW);

    // A device that never saw the account copy (base 0) is told, and gets the current copy to merge with.
    const stale = await call('PUT', '/me/taste', { user: u, body: { taste: emptyTaste(), base: 0 }, now: NOW + 1000 });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'taste_changed']);
    expect(stale.json.error.current).toEqual({ taste: liked(), updated_at: NOW });

    // With the right base it goes through, and the version moves forward.
    const next = await call('PUT', '/me/taste', { user: u, body: { taste: { ...liked(), on: false }, base: NOW }, now: NOW + 2000 });
    expect(next.status).toBe(200);
    expect(next.json.updated_at).toBe(NOW + 2000);
    // The old base is now stale.
    expect((await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: NOW }, now: NOW + 3000 })).status).toBe(409);
  });

  it('never goes back in time, even when the clock does', async () => {
    const u = await user();
    await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: 0 }, now: NOW });
    const put = await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: NOW }, now: NOW - 5000 });
    expect(put.json.updated_at).toBe(NOW + 1);
  });
});

describe('deleting the account', () => {
  it('removes the taste with it', async () => {
    const u = await user();
    await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: 0 } });
    expect((await call('DELETE', '/me', { user: u })).json).toEqual({ deleted: true });
    expect(await env.DB.prepare('SELECT 1 FROM user_taste WHERE user_id = ?').bind(u).first()).toBeNull();
  });
  it('leaves other people alone', async () => {
    const a = await user(), b = await user();
    await call('PUT', '/me/taste', { user: a, body: { taste: liked(), base: 0 } });
    await call('PUT', '/me/taste', { user: b, body: { taste: liked(), base: 0 } });
    await call('DELETE', '/me', { user: a });
    expect((await call('GET', '/me/taste', { user: b })).json.taste).toEqual(liked());
  });
});

describe('the public list stays the same for everyone', () => {
  it('carries no taste', async () => {
    const u = await user();
    await call('PUT', '/me/taste', { user: u, body: { taste: liked(), base: 0 } });
    for (const path of ['/popups', '/popups/snapshot']) {
      const anon = await call('GET', path);
      const signedIn = await call('GET', path, { user: u });
      expect(signedIn.json).toEqual(anon.json);
      expect(JSON.stringify(anon.json)).not.toContain('"swipes"');
    }
  });
});
