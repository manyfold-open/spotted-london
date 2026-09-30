import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const NOW = Date.UTC(2026, 8, 30, 13);
const ORIGIN = 'http://spotted.test';

type Opts = { body?: unknown; form?: Record<string, string>; cookie?: string; now?: number; origin?: string; ip?: string };
async function call(method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { 'x-now': String(o.now ?? NOW) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin) headers.origin = o.origin;
  if (o.ip) headers['x-dev-ip'] = o.ip;
  let body: BodyInit | undefined;
  if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
  if (o.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  const res = await exports.default.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: 'manual' }));
  const type = res.headers.get('content-type') ?? '';
  const data: any = type.includes('json') ? await res.json() : await res.text();
  const sid = res.headers.getSetCookie().map(c => /^sid=([^;]*)/.exec(c)?.[1]).find(v => v !== undefined);
  return { res, status: res.status, data, sid, location: res.headers.get('location') };
}

let n = 0;
const email = () => `person${++n}_${Math.random().toString(36).slice(2, 6)}@example.com`;
const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;

async function signIn(addr: string) {
  const link = (await call('POST', '/api/v1/auth/magic-link', { body: { email: addr } })).data.dev_link;
  const r = await call('POST', '/api/v1/auth/magic/verify', { body: { token: tokenFrom(link) } });
  return `sid=${r.sid}`;
}

afterEach(() => vi.restoreAllMocks());

describe('email magic link', () => {
  it('signs in through the confirm page and creates a verified account', async () => {
    const addr = email();
    const req = await call('POST', '/api/v1/auth/magic-link', { body: { email: `  ${addr.toUpperCase()} ` } });
    expect(req.status).toBe(200);
    expect(req.data.dev_link).toMatch(/^http:\/\/spotted\.test\/login\/verify\?token=/);

    // Opening the link only shows a button, so an email scanner cannot use it up.
    const page = await call('GET', new URL(req.data.dev_link).pathname + new URL(req.data.dev_link).search);
    expect(page.status).toBe(200);
    expect(page.data).toContain('<form method="post" action="/login/verify">');
    expect(page.res.headers.get('cache-control')).toBe('no-store');

    const done = await call('POST', '/login/verify', { form: { token: tokenFrom(req.data.dev_link), return_to: '/saved' }, origin: ORIGIN });
    expect(done.status).toBe(303);
    expect(done.location).toBe('/saved');
    expect(done.res.headers.getSetCookie()[0]).toMatch(/HttpOnly/i);
    expect(done.res.headers.getSetCookie()[0]).toMatch(/SameSite=Lax/i);

    const me = await call('GET', '/api/v1/me', { cookie: `sid=${done.sid}` });
    expect(me.status).toBe(200);
    expect(me.data.email).toBe(addr);
    const row = await env.DB.prepare('SELECT email_verified FROM users WHERE email = ?').bind(addr).first<{ email_verified: number }>();
    expect(row!.email_verified).toBe(1);
  });

  it('works once, expires after 15 minutes and never stores the raw token', async () => {
    const link = (await call('POST', '/api/v1/auth/magic-link', { body: { email: email() } })).data.dev_link;
    const token = tokenFrom(link);
    expect(await env.DB.prepare('SELECT 1 FROM login_tokens WHERE token_hash = ?').bind(token).first()).toBeNull();

    expect((await call('POST', '/api/v1/auth/magic/verify', { body: { token } })).status).toBe(200);
    const again = await call('POST', '/api/v1/auth/magic/verify', { body: { token } });
    expect(again.status).toBe(400);
    expect(again.data.error.code).toBe('link_invalid');

    const late = (await call('POST', '/api/v1/auth/magic-link', { body: { email: email() } })).data.dev_link;
    expect((await call('POST', '/api/v1/auth/magic/verify', { body: { token: tokenFrom(late) }, now: NOW + 16 * 60_000 })).status).toBe(400);
    expect((await call('POST', '/login/verify', { form: { token: 'nope' } })).status).toBe(400);
  });

  it('limits links per email and rejects bad addresses', async () => {
    const addr = email();
    for (let i = 0; i < 3; i++) expect((await call('POST', '/api/v1/auth/magic-link', { body: { email: addr }, ip: `10.9.0.${i}` })).status).toBe(200);
    expect((await call('POST', '/api/v1/auth/magic-link', { body: { email: addr }, ip: '10.9.0.9' })).status).toBe(429);
    expect((await call('POST', '/api/v1/auth/magic-link', { body: { email: 'not-an-email' } })).data.error.code).toBe('email_invalid');
  });

  it('only redirects to paths on this site', async () => {
    const addr = email();
    const link = (await call('POST', '/api/v1/auth/magic-link', { body: { email: addr } })).data.dev_link;
    const done = await call('POST', '/login/verify', { form: { token: tokenFrom(link), return_to: '//evil.example/x' } });
    expect(done.location).toBe('/');
  });

  it('refuses banned accounts', async () => {
    const addr = email();
    await signIn(addr);
    await env.DB.prepare("UPDATE users SET status = 'banned' WHERE email = ?").bind(addr).run();
    const link = (await call('POST', '/api/v1/auth/magic-link', { body: { email: addr } })).data.dev_link;
    expect((await call('POST', '/login/verify', { form: { token: tokenFrom(link) } })).status).toBe(403);
  });
});

describe('sessions', () => {
  it('signs out for real and ignores made-up cookies', async () => {
    const cookie = await signIn(email());
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(200);
    expect((await call('POST', '/api/v1/auth/logout', { cookie, origin: ORIGIN })).status).toBe(200);
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(401);
    expect((await call('GET', '/api/v1/me', { cookie: 'sid=forged' })).status).toBe(401);
  });

  it('expires after 30 days', async () => {
    const cookie = await signIn(email());
    expect((await call('GET', '/api/v1/me', { cookie, now: NOW + 31 * 86_400_000 })).status).toBe(401);
  });

  it('blocks cross-site writes that carry the session cookie', async () => {
    const cookie = await signIn(email());
    const evil = await call('PATCH', '/api/v1/me', { cookie, origin: 'https://evil.example', body: { display_name: 'Hacked' } });
    expect(evil.status).toBe(403);
    expect(evil.data.error.code).toBe('cross_site');
    const ok = await call('PATCH', '/api/v1/me', { cookie, origin: ORIGIN, body: { display_name: 'Zack C.' } });
    expect(ok.status).toBe(200);
    expect((await call('PATCH', '/api/v1/me', { cookie, origin: ORIGIN, body: { display_name: 'me@mail.com' } })).status).toBe(400);
  });
});

describe('Google sign in', () => {
  const idToken = (claims: Record<string, unknown>) =>
    `h.${btoa(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'test-client.apps.googleusercontent.com', exp: NOW / 1000 + 3600, ...claims }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

  async function start(returnTo = '/map') {
    const r = await call('GET', `/api/v1/auth/google?return_to=${encodeURIComponent(returnTo)}`);
    const loc = new URL(r.location!);
    const stateCookie = r.res.headers.getSetCookie().map(c => /^oauth_state=([^;]*)/.exec(c)?.[1]).find(Boolean)!;
    return { r, loc, state: loc.searchParams.get('state')!, cookie: `oauth_state=${stateCookie}` };
  }

  it('redirects to Google with PKCE and a state bound to this browser', async () => {
    const { r, loc, state, cookie } = await start();
    expect(r.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/v1/auth/google/callback`);
    expect(cookie).toBe(`oauth_state=${state}`);
  });

  it('creates an account from a verified Google email and returns to the page', async () => {
    const { state, cookie } = await start('/map');
    const addr = email();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ id_token: idToken({ sub: 'g-123', email: addr, email_verified: true, name: 'Ada L.' }) }));
    const cb = await call('GET', `/api/v1/auth/google/callback?code=abc&state=${state}`, { cookie });
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${ORIGIN}/map`);
    expect(cb.sid).toBeTruthy();
    const sent = new URLSearchParams(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(sent.get('code_verifier')).toBeTruthy();
    const me = await call('GET', '/api/v1/me', { cookie: `sid=${cb.sid}` });
    expect(me.data).toMatchObject({ email: addr, name: 'Ada L.' });
  });

  it('links Google to an existing email account instead of making a second one', async () => {
    const addr = email();
    await signIn(addr);
    const { state, cookie } = await start();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id_token: idToken({ sub: 'g-link', email: addr, email_verified: true }) }));
    await call('GET', `/api/v1/auth/google/callback?code=abc&state=${state}`, { cookie });
    const rows = await env.DB.prepare('SELECT google_sub FROM users WHERE email = ?').bind(addr).all<{ google_sub: string }>();
    expect(rows.results).toEqual([{ google_sub: 'g-link' }]);
  });

  it('rejects a missing state cookie, reused state and unverified emails', async () => {
    const a = await start();
    expect((await call('GET', `/api/v1/auth/google/callback?code=abc&state=${a.state}`)).location).toContain('login_error=state_mismatch');

    const b = await start();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id_token: idToken({ sub: 'g-x', email: email(), email_verified: false }) }));
    expect((await call('GET', `/api/v1/auth/google/callback?code=abc&state=${b.state}`, { cookie: b.cookie })).location).toContain('login_error=google_token_invalid');
    expect((await call('GET', `/api/v1/auth/google/callback?code=abc&state=${b.state}`, { cookie: b.cookie })).location).toContain('login_error=state_expired');

    const c = await start();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id_token: idToken({ sub: 'g-y', email: email(), email_verified: true, aud: 'someone-else' }) }));
    expect((await call('GET', `/api/v1/auth/google/callback?code=abc&state=${c.state}`, { cookie: c.cookie })).location).toContain('login_error=google_token_invalid');
  });
});
