import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

// The new code can run before migration 0020 is applied: taste routes say so, and nothing else breaks.
const NOW = Date.UTC(2026, 9, 8, 13);
async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-now': String(NOW), 'x-dev-user': 'old_schema_u' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as any };
}

describe('before migration 0020', () => {
  it('answers 503 on /me/taste and still deletes the account', async () => {
    await env.DB.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('old_schema_u', 'old_schema_u@test.dev', 'user', ?)").bind(NOW).run();
    await env.DB.exec('DROP TABLE user_taste');
    const get = await call('GET', '/me/taste');
    expect([get.status, get.json.error.code]).toEqual([503, 'taste_unavailable']);
    const put = await call('PUT', '/me/taste', { taste: { v: 1, cats: {}, boroughs: {}, free: { y: 0, n: 0 }, swipes: 0, on: false, seen: false }, base: 0 });
    expect([put.status, put.json.error.code]).toEqual([503, 'taste_unavailable']);
    expect((await call('GET', '/me')).status).toBe(200);
    expect((await call('DELETE', '/me')).json).toEqual({ deleted: true });
  });
});
