import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const call = (method: string, path: string, body?: unknown) => exports.default.fetch(new Request(`http://spotted.test/api/v1/newsletter${path}`, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe('newsletter (sign-up closed until email sending is connected)', () => {
  it('answers 503 newsletter_unavailable and stores nothing', async () => {
    const res = await call('POST', '/subscribe', { email: 'closed-signup@test.dev' });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('newsletter_unavailable');
    expect(json.error.message).toMatch(/coming soon/i);
    const row = await env.DB.prepare('SELECT 1 FROM subscribers WHERE email = ?').bind('closed-signup@test.dev').first();
    expect(row).toBeNull();
  });

  it('lets an old row confirm and unsubscribe', async () => {
    await env.DB.prepare('INSERT INTO subscribers (email, token, created_at) VALUES (?, ?, ?)').bind('old-row@test.dev', 'tok_old_row', 1).run();
    expect((await call('GET', '/confirm?token=tok_old_row')).status).toBe(200);
    expect((await call('GET', '/unsubscribe?token=tok_old_row')).status).toBe(200);
    const row = await env.DB.prepare('SELECT confirmed, unsubscribed_at FROM subscribers WHERE email = ?').bind('old-row@test.dev').first<{ confirmed: number; unsubscribed_at: number | null }>();
    expect(row!.confirmed).toBe(1);
    expect(row!.unsubscribed_at).not.toBeNull();
    expect((await call('GET', '/unsubscribe?token=nope')).status).toBe(404);
  });
});
