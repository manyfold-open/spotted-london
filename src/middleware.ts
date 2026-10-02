import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv, UserRow } from './types';
import { ApiError, sha256 } from './lib/util';
import { SESSION_COOKIE } from './lib/auth';

const isDev = (c: Context<AppEnv>) => c.env.ENVIRONMENT === 'development';

/** GET routes that never read the user, so the session lookup is skipped for them. */
const PUBLIC_PATHS = new Set(['/api/v1/popups']);

/**
 * Loads the signed-in user.
 * - `sid` session cookie from sign in; the database only holds its SHA-256.
 * - Development only: `x-dev-user: <user id>` header, and `x-now` to pin the clock in tests.
 */
export const session = createMiddleware<AppEnv>(async (c, next) => {
  const pinned = isDev(c) ? Number(c.req.header('x-now')) : NaN;
  c.set('now', Number.isFinite(pinned) && pinned > 0 ? pinned : Date.now());

  // The public list is the same for everyone, so it does not need to know who is asking.
  if (c.req.method === 'GET' && PUBLIC_PATHS.has(c.req.path.replace(/\/+$/, ''))) {
    c.set('user', null);
    return next();
  }

  let user: UserRow | null = null;
  const devUser = isDev(c) ? c.req.header('x-dev-user') : undefined;
  if (devUser) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(devUser).first<UserRow>();
  } else {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) {
      user = await c.env.DB.prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
      ).bind(await sha256(sid), c.get('now')).first<UserRow>();
    }
  }
  c.set('user', user && user.status !== 'deleted' ? user : null);
  await next();
});

export function requireUser(c: Context<AppEnv>): UserRow {
  const u = c.get('user');
  if (!u) throw new ApiError(401, 'auth_required', 'Sign in to do this.');
  if (u.status === 'banned') throw new ApiError(403, 'banned', 'This account is suspended.');
  return u;
}

export function requireAdmin(c: Context<AppEnv>): UserRow {
  const u = requireUser(c);
  if (u.role !== 'admin') throw new ApiError(403, 'admin_only', 'Only admins can do this.');
  return u;
}

/** The user behind calls made with AGENT_ADMIN_TOKEN, so the audit log names it. It cannot sign in. */
const MANAGER_ID = 'sys_agent_manager';

async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(x), enc.encode(y));
}

/**
 * For the routes that manage AI agents only: an admin session, or the AGENT_ADMIN_TOKEN secret sent as
 * `Authorization: Bearer <token>`. The token is for Claude Code and scripts. It opens nothing else:
 * not the review queue, users, reports or the Publishing switch.
 */
export async function requireAgentManager(c: Context<AppEnv>): Promise<UserRow> {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return requireAdmin(c);
  const secret = c.env.AGENT_ADMIN_TOKEN;
  if (!secret || secret.length < 32 || !(await sameSecret(bearer, secret))) {
    throw new ApiError(401, 'agent_token_invalid', 'That agent manager token is not valid.');
  }
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES (?, 'agent-manager@system.invalid', 'Agent manager token', 'user', 0, 0, ?)",
  ).bind(MANAGER_ID, c.get('now')).run();
  return (await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(MANAGER_ID).first<UserRow>())!;
}

/** Cloudflare Turnstile. Skipped when no secret is configured (local dev). */
export async function verifyTurnstile(c: Context<AppEnv>, token: string | undefined): Promise<void> {
  const secret = c.env.TURNSTILE_SECRET;
  if (!secret) {
    if (isDev(c)) return;
    throw new ApiError(501, 'turnstile_not_configured', 'Bot check is not configured on the server.');
  }
  if (!token) throw new ApiError(400, 'bot_check_missing', 'Complete the bot check and try again.');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret, response: token, remoteip: c.req.header('cf-connecting-ip') ?? '' }),
  });
  const out = (await res.json()) as { success: boolean };
  if (!out.success) throw new ApiError(400, 'bot_check_failed', 'The bot check failed. Try again.');
}

/** Salted hash of the client IP. The raw IP is never stored (SPEC §8). */
export async function ipHash(c: Context<AppEnv>): Promise<string | null> {
  const ip = c.req.header('cf-connecting-ip') ?? (isDev(c) ? c.req.header('x-dev-ip') : undefined);
  if (!ip) return null;
  return (await sha256(`${c.env.IP_SALT ?? ''}:${ip}`)).slice(0, 32);
}

/** The site's own origin, from APP_URL (falls back to the request origin in development). */
export function appOrigin(c: Context<AppEnv>): string {
  const u = c.env.APP_URL;
  if (u) return new URL(u).origin;
  if (isDev(c)) return new URL(c.req.url).origin;
  throw new ApiError(501, 'app_url_missing', 'APP_URL is not configured on the server.');
}

/**
 * CSRF guard for cookie sessions. SameSite=Lax already blocks most cross-site posts;
 * this also rejects state-changing requests whose Origin is another site.
 */
export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || !getCookie(c, SESSION_COOKIE)) return next();
  const origin = c.req.header('origin');
  const site = c.req.header('sec-fetch-site');
  const allowed = new Set([new URL(c.req.url).origin]);
  if (c.env.APP_URL) allowed.add(new URL(c.env.APP_URL).origin);
  if ((origin && !allowed.has(origin)) || site === 'cross-site') {
    throw new ApiError(403, 'cross_site', 'This request came from another site and was blocked.');
  }
  await next();
});
