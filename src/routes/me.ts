import { Hono } from 'hono';
import type { AppEnv, PopupRow } from '../types';
import { requireUser } from '../middleware';
import { ApiError, bad } from '../lib/util';
import { jsonBody, text } from '../lib/validate';
import { trust, voteWeight } from '../lib/scoring';
import { toPublic } from '../db/popups';

export const me = new Hono<AppEnv>();

me.get('/', c => {
  const u = requireUser(c);
  return c.json({
    id: u.id, email: u.email, name: u.display_name, role: u.role, karma: u.karma,
    trust: trust({ karma: u.karma, verifiedPosts: u.verified_posts, badPosts: u.bad_posts }),
    vote_weight: voteWeight({ karma: u.karma, createdAt: u.created_at, emailVerified: !!u.email_verified, status: u.status }, c.get('now')),
    verified_posts: u.verified_posts, created_at: u.created_at,
  });
});

/** The name shown next to your posts. Emails are never shown publicly. */
me.patch('/', async c => {
  const u = requireUser(c);
  const b = await jsonBody(c.req);
  const name = text(b, 'display_name', { min: 2, max: 40, required: true })!;
  if (/@|https?:\/\//i.test(name)) throw bad('display_name_invalid', 'Names cannot contain emails or links.');
  await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, u.id).run();
  return c.json({ display_name: name });
});

me.get('/saves', async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare(
    'SELECT p.* FROM saves s JOIN popups p ON p.id = s.popup_id WHERE s.user_id = ? ORDER BY p.start_at',
  ).bind(u.id).all<PopupRow>();
  return c.json({ items: results.map(p => toPublic(p)) });
});

me.get('/popups', async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM popups WHERE created_by = ? ORDER BY created_at DESC LIMIT 100').bind(u.id).all<PopupRow>();
  return c.json({ items: results.map(p => toPublic(p)) });
});

me.get('/karma', async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare(
    'SELECT delta, reason, ref_id, created_at FROM karma_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
  ).bind(u.id).all();
  return c.json({ karma: u.karma, items: results });
});

/** GDPR delete: personal data goes, posts stay but are anonymised (SPEC §3.4). */
me.delete('/', async c => {
  const u = requireUser(c);
  if (u.role === 'admin') throw new ApiError(409, 'admin_account', 'Hand over admin access before deleting this account.');
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE users SET email = ?, display_name = NULL, avatar_key = NULL, status = 'deleted' WHERE id = ?").bind(`deleted-${u.id}@invalid`, u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM saves WHERE user_id = ?').bind(u.id),
    db.prepare('UPDATE checkins SET lat = NULL, lng = NULL WHERE user_id = ?').bind(u.id),
  ]);
  return c.json({ deleted: true });
});
