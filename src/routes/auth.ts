import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, UserRow } from '../types';
import { appOrigin, ipHash, verifyTurnstile } from '../middleware';
import { ApiError, bad, newId, sha256 } from '../lib/util';
import { jsonBody, text } from '../lib/validate';
import {
  jwtPayload, MAGIC_TTL, normaliseEmail, OAUTH_COOKIE, OAUTH_TTL, pkceChallenge, randomToken, safeReturnTo,
  SESSION_COOKIE, SESSION_TTL,
} from '../lib/auth';
import { magicLinkEmail, sendEmail } from '../services/email';

export const auth = new Hono<AppEnv>();

const isDev = (c: Context<AppEnv>) => c.env.ENVIRONMENT === 'development';
const isHttps = (c: Context<AppEnv>) => new URL(c.req.url).protocol === 'https:';

/* ---------------- sessions ---------------- */

export async function startSession(c: Context<AppEnv>, userId: string) {
  const token = randomToken();
  const now = c.get('now');
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now + SESSION_TTL, now).run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: SESSION_TTL / 1000,
  });
}

/** Finds the account for a verified email, or creates it. Banned accounts cannot sign in. */
export async function userForEmail(
  db: D1Database, email: string, now: number, extra: { name?: string | null; googleSub?: string } = {},
): Promise<UserRow> {
  let u = extra.googleSub
    ? await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(extra.googleSub).first<UserRow & { google_sub: string | null }>()
    : null;
  u ??= await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow & { google_sub: string | null }>();
  if (u) {
    if (u.status === 'banned') throw new ApiError(403, 'banned', 'This account is suspended.');
    await db.prepare(
      'UPDATE users SET email_verified = 1, google_sub = COALESCE(google_sub, ?), display_name = COALESCE(display_name, ?) WHERE id = ?',
    ).bind(extra.googleSub ?? null, extra.name ?? null, u.id).run();
    return (await db.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first<UserRow>())!;
  }
  const id = newId();
  await db.prepare(
    'INSERT INTO users (id, email, display_name, email_verified, google_sub, created_at) VALUES (?, ?, ?, 1, ?, ?)',
  ).bind(id, email, extra.name?.slice(0, 60) ?? null, extra.googleSub ?? null, now).run();
  return (await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>())!;
}

const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.display_name, role: u.role, karma: u.karma });

/* ---------------- email magic link ---------------- */

auth.post('/magic-link', async c => {
  const now = c.get('now');
  const b = await jsonBody(c.req);
  await verifyTurnstile(c, typeof b.turnstile_token === 'string' ? b.turnstile_token : undefined);
  const email = normaliseEmail(text(b, 'email', { max: 254, required: true })!);
  if (!email) throw bad('email_invalid', 'Enter a valid email address.');
  const returnTo = safeReturnTo(typeof b.return_to === 'string' ? b.return_to : null);
  const db = c.env.DB;
  const ip = await ipHash(c);

  const hour = now - 3_600_000;
  const [byEmail, byIp] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?').bind(email, hour).first<{ n: number }>(),
    ip ? db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE ip_hash = ? AND created_at > ?').bind(ip, hour).first<{ n: number }>() : null,
  ]);
  if ((byEmail?.n ?? 0) >= 3 || (byIp?.n ?? 0) >= 10) {
    throw new ApiError(429, 'too_many_links', 'We sent a few links already. Check your inbox, or try again in an hour.');
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  await db.prepare('INSERT INTO login_tokens (token_hash, email, ip_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, email, ip, now + MAGIC_TTL, now).run();

  const link = `${appOrigin(c)}/login/verify?token=${token}${returnTo !== '/' ? `&return_to=${encodeURIComponent(returnTo)}` : ''}`;
  const sent = await sendEmail(c.env, { to: email, ...magicLinkEmail(link) }).catch(() => {
    throw new ApiError(502, 'email_failed', 'We could not send the email. Try again in a minute.');
  });
  if (!sent) {
    if (isDev(c)) return c.json({ ok: true, message: 'Email is not configured, so here is the link.', dev_link: link });
    await db.prepare('DELETE FROM login_tokens WHERE token_hash = ?').bind(tokenHash).run();
    throw new ApiError(501, 'email_not_configured', 'Email sign-in is not set up yet. Sign in with Google instead.');
  }
  // Same answer whether or not an account exists, so this cannot be used to probe emails.
  return c.json({ ok: true, message: 'Check your inbox. The link works once and expires in 15 minutes.' });
});

/** Single use: the UPDATE only succeeds for an unused, unexpired token. */
export async function consumeMagicToken(db: D1Database, token: string, now: number): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db.prepare(
    'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email',
  ).bind(now, await sha256(token), now).first<{ email: string }>();
  return row?.email ?? null;
}

auth.post('/magic/verify', async c => {
  const b = await jsonBody(c.req);
  const email = await consumeMagicToken(c.env.DB, text(b, 'token', { max: 100, required: true })!, c.get('now'));
  if (!email) throw new ApiError(400, 'link_invalid', 'This sign-in link has expired or was already used. Ask for a new one.');
  const u = await userForEmail(c.env.DB, email, c.get('now'));
  await startSession(c, u.id);
  return c.json({ user: publicUser(u) });
});

/* ---------------- sign out ---------------- */

auth.post('/logout', async c => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(sid)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
  return c.json({ ok: true });
});

/* ---------------- Google (OIDC authorization code + PKCE) ---------------- */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const googleRedirect = (c: Context<AppEnv>) => `${appOrigin(c)}/api/v1/auth/google/callback`;

auth.get('/google', async c => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw new ApiError(501, 'google_not_configured', 'Google sign-in is not set up yet. Use the email link instead.');
  }
  const state = randomToken(), verifier = randomToken(48);
  await c.env.DB.prepare('INSERT INTO oauth_states (state_hash, verifier, return_to, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(state), verifier, safeReturnTo(c.req.query('return_to')), c.get('now') + OAUTH_TTL).run();
  // Ties the callback to this browser, which stops login CSRF.
  setCookie(c, OAUTH_COOKIE, state, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/api/v1/auth/google', maxAge: OAUTH_TTL / 1000 });
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirect(c), response_type: 'code', scope: 'openid email profile',
    state, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', prompt: 'select_account',
  });
  return c.redirect(`${GOOGLE_AUTH}?${q}`, 302);
});

interface GoogleClaims { iss: string; aud: string; sub: string; email?: string; email_verified?: boolean; name?: string; exp: number }

auth.get('/google/callback', async c => {
  const fail = (code: string) => c.redirect(`${appOrigin(c)}/?login_error=${code}`, 302);
  const q = c.req.query();
  const cookieState = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/v1/auth/google', secure: isHttps(c) });
  if (q.error) return fail('google_cancelled');
  if (!q.code || !q.state || !cookieState || cookieState !== q.state) return fail('state_mismatch');

  const now = c.get('now');
  const st = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING verifier, return_to')
    .bind(await sha256(q.state), now).first<{ verifier: string; return_to: string | null }>();
  if (!st) return fail('state_expired');

  let claims: GoogleClaims | null = null;
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: q.code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: googleRedirect(c), grant_type: 'authorization_code', code_verifier: st.verifier,
      }),
    });
    if (!res.ok) return fail('google_exchange_failed');
    const tok = (await res.json()) as { id_token?: string };
    claims = tok.id_token ? jwtPayload<GoogleClaims>(tok.id_token) : null;
  } catch {
    return fail('google_unreachable');
  }
  // The token came straight from Google over TLS, so checking the claims is enough (OIDC Core 3.1.3.7).
  if (!claims
    || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)
    || claims.aud !== c.env.GOOGLE_CLIENT_ID
    || claims.exp * 1000 < now
    || !claims.email || claims.email_verified !== true) return fail('google_token_invalid');

  const email = normaliseEmail(claims.email);
  if (!email) return fail('google_token_invalid');
  let u: UserRow;
  try {
    u = await userForEmail(c.env.DB, email, now, { name: claims.name ?? null, googleSub: claims.sub });
  } catch (e) {
    return fail(e instanceof ApiError ? e.code : 'server_error');
  }
  await startSession(c, u.id);
  return c.redirect(`${appOrigin(c)}${safeReturnTo(st.return_to)}`, 302);
});
