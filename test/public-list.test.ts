import { describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 13);

async function api(path: string, o: { user?: string; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { 'x-now': String(NOW) };
  if (o.user) headers['x-dev-user'] = o.user;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, {
    method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }));
  return { status: res.status, text: await res.text() };
}
const get = async (path: string, user?: string) => {
  const r = await api(path, { user });
  return { status: r.status, text: r.text, json: r.text ? JSON.parse(r.text) : null };
};

async function seed() {
  const stmts = [
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('pl_poster', 'pl_poster@test.dev', 'Poster', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY),
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('pl_me', 'pl_me@test.dev', 'Me', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY),
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('pl_other', 'pl_other@test.dev', 'Other', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY),
  ];
  const add = (id: string, title: string, startAt: number, endAt: number, status = 'community') =>
    env.DB.prepare(`INSERT INTO popups (id, slug, title, category, start_at, end_at, lat, lng, geohash, address, status, created_by, created_at, updated_at, hot, is_example)
      VALUES (?, ?, ?, 'other', ?, ?, 51.5, -0.1, 'gcpvj', 'A', ?, 'pl_poster', ?, ?, 1, 0)`).bind(id, id, title, startAt, endAt, status, NOW, NOW);
  stmts.push(
    add('pl_a', 'List A', NOW + DAY, NOW + 2 * DAY),
    add('pl_b', 'List B', NOW - DAY, NOW + DAY),
    add('pl_old', 'Ended long ago', NOW - 30 * DAY, NOW - 20 * DAY, 'ended'),
    add('pl_recent', 'Ended yesterday', NOW - 2 * DAY, NOW - DAY, 'ended'),
  );
  const vote = (u: string, p: string, kind: string, value: number) =>
    env.DB.prepare('INSERT INTO votes (user_id, popup_id, kind, value, weight, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(u, p, kind, value, NOW);
  const save = (u: string, p: string) => env.DB.prepare('INSERT INTO saves (user_id, popup_id, remind, created_at) VALUES (?, ?, 1, ?)').bind(u, p, NOW);
  stmts.push(
    vote('pl_me', 'pl_a', 'existence', 1), vote('pl_me', 'pl_a', 'quality', -1), vote('pl_me', 'pl_b', 'quality', 1),
    vote('pl_me', 'pl_old', 'existence', 1), vote('pl_other', 'pl_b', 'existence', -1),
    save('pl_me', 'pl_a'), save('pl_me', 'pl_old'), save('pl_me', 'pl_recent'), save('pl_other', 'pl_b'),
  );
  await env.DB.batch(stmts);
}
await seed();

describe('the public list', () => {
  it('is the same for a signed-in user and a visitor, and carries no personal state', async () => {
    const visitor = await get('/popups?when=all');
    const member = await get('/popups?when=all', 'pl_me');
    expect(visitor.status).toBe(200);
    expect(member.text).toBe(visitor.text);
    expect(visitor.json.items.some((p: { id: string }) => p.id === 'pl_a')).toBe(true);
    for (const p of visitor.json.items) expect(p).not.toHaveProperty('me');
  });

  it('does not look the user up', async () => {
    const spy = vi.spyOn(env.DB, 'prepare');
    await get('/popups?when=all', 'pl_me');
    const sql = spy.mock.calls.map(c => String(c[0]));
    spy.mockRestore();
    expect(sql.some(s => /FROM users/i.test(s) || /FROM sessions/i.test(s))).toBe(false);
  });

  it('still shows your state on the detail page', async () => {
    const d = await get('/popups/pl_a', 'pl_me');
    expect(d.json.me).toMatchObject({ saved: true, existence_vote: 1, quality_vote: -1 });
  });
});

describe('GET /me/state', () => {
  it('needs a signed-in user', async () => {
    expect((await get('/me/state')).status).toBe(401);
  });

  it('returns saved ids and votes for pop-ups that are still relevant, and only yours', async () => {
    const r = await get('/me/state', 'pl_me');
    expect(r.status).toBe(200);
    expect([...r.json.saved].sort()).toEqual(['pl_a', 'pl_recent']);
    expect(r.json.votes).toEqual({
      pl_a: { existence: 1, quality: -1 },
      pl_b: { existence: 0, quality: 1 },
    });
  });

  it('is empty for someone with nothing', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES ('pl_blank', 'pl_blank@test.dev', ?)").bind(NOW).run();
    expect((await get('/me/state', 'pl_blank')).json).toEqual({ saved: [], votes: {} });
  });

  it('reads saves and votes through their user_id indexes, not a table scan', async () => {
    for (const sql of [
      'SELECT s.popup_id FROM saves s JOIN popups p ON p.id = s.popup_id WHERE s.user_id = ? AND p.end_at > ?',
      'SELECT v.popup_id, v.kind, v.value FROM votes v JOIN popups p ON p.id = v.popup_id WHERE v.user_id = ? AND p.end_at > ?',
    ]) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind('pl_me', 0).all<{ detail: string }>();
      const plan = results.map(r => r.detail).join(' | ');
      expect(plan).not.toMatch(/SCAN (s|v)\b|SCAN (saves|votes)\b/);
      expect(plan).toMatch(/USING (COVERING )?INDEX|PRIMARY KEY/);
    }
  });
});
