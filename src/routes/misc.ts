import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ApiError } from '../lib/util';

/* ---------- newsletter (sign-up closed for now; confirm and unsubscribe still work for old rows) ---------- */
export const newsletter = new Hono<AppEnv>();

// Closed until email sending is connected (Resend). Nothing is stored, so nobody is signed up for a mail that never comes.
newsletter.post('/subscribe', () => {
  throw new ApiError(503, 'newsletter_unavailable', 'The weekly digest is coming soon. Sign-up is not open yet.');
});

newsletter.get('/confirm', async c => {
  const token = c.req.query('token') ?? '';
  const r = await c.env.DB.prepare('UPDATE subscribers SET confirmed = 1 WHERE token = ? AND unsubscribed_at IS NULL').bind(token).run();
  if (!r.meta.changes) throw new ApiError(404, 'token_invalid', 'This confirmation link is invalid or expired.');
  return c.json({ confirmed: true });
});

newsletter.get('/unsubscribe', async c => {
  const token = c.req.query('token') ?? '';
  const r = await c.env.DB.prepare('UPDATE subscribers SET unsubscribed_at = ? WHERE token = ?').bind(c.get('now'), token).run();
  if (!r.meta.changes) throw new ApiError(404, 'token_invalid', 'This unsubscribe link is invalid.');
  return c.json({ unsubscribed: true });
});

/* ---------- images served from R2 ---------- */
export const images = new Hono<AppEnv>();

images.get('/*', async c => {
  const key = c.req.path.replace(/^\/api\/v1\/images\//, '');
  if (!/^(popups|thumbs)\/[\w]+\/[\w]+\.(webp|jpg|png)$/.test(key)) throw new ApiError(404, 'not_found', 'Image not found.');
  const obj = c.env.IMAGES ? await c.env.IMAGES.get(key) : null;
  if (!obj) throw new ApiError(404, 'not_found', 'Image not found.');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // Every upload gets a new key (newId), so a key's bytes never change: the browser can keep it for good
  // instead of asking the Worker and R2 again for each photo each time the list scrolls into view.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

/* ---------- public profiles ---------- */
export const users = new Hono<AppEnv>();

users.get('/:id', async c => {
  const u = await c.env.DB.prepare(
    "SELECT id, display_name, karma, verified_posts, created_at FROM users WHERE id = ? AND status IN ('active', 'shadowbanned')",
  ).bind(c.req.param('id')).first();
  if (!u) throw new ApiError(404, 'not_found', 'This user does not exist.');
  return c.json(u);
});
