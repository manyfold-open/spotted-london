// Give public pop-ups that have no photo a real one: the main picture of the page they came from.
// Runs from the 10 minute cron, a few pop-ups at a time (each one costs a page fetch, a photo fetch and an R2 write,
// and a Worker invocation may only make so many subrequests). Same rules as every copied photo: into R2, never
// hotlinked, credited to the page (see addPhotoFromUrl).

import type { Bindings } from '../types';
import { addPhotoFromUrl, pagePhoto, type PhotoSource } from '../lib/photo';
import { safeUrl } from '../lib/extract';

export const BACKFILL_BATCH = 5;
export const RETRY_AFTER = 14 * 86_400_000;
/** The same picture on this many pop-ups is a site logo or a default share image, not a photo of the pop-up. */
export const SHARED_IMAGE_LIMIT = 2;
const BOT_ID = 'sys_photo_bot';
/** Login walls: there is no picture to read without signing in (the Scout reads these through Apify instead). */
const SOCIAL_HOSTS = /(^|\.)(instagram\.com|instagr\.am|threads\.net|threads\.com|tiktok\.com|xiaohongshu\.com|xhslink\.com|facebook\.com|fb\.com)$/;
const NOT_A_PHOTO = /(logo|favicon|sprite|placeholder|default[-_]?(image|share|og|social)|site[-_]?icon|avatar)/i;

type Candidate = { id: string; source_url: string | null };

/** The page addresses to try for one pop-up: its source link, then the other links the Scout saved. */
export async function pagesFor(db: D1Database, p: Candidate): Promise<string[]> {
  const { results } = await db.prepare("SELECT url FROM popup_links WHERE popup_id = ? AND kind IN ('official', 'venue', 'ticket', 'article', 'other') LIMIT 4").bind(p.id).all<{ url: string }>();
  const all = [p.source_url, ...results.map(r => r.url)].filter((u): u is string => !!u);
  const seen = new Set<string>();
  return all.filter(u => {
    const url = safeUrl(u);
    if (!url || SOCIAL_HOSTS.test(url.hostname) || seen.has(url.toString())) return false;
    seen.add(url.toString());
    return true;
  }).slice(0, 2);
}

/** Try one pop-up. Returns the reason it got no photo, or null when one was saved. */
export async function backfillOne(env: Pick<Bindings, 'DB' | 'IMAGES'>, p: Candidate, now: number, fetcher: typeof fetch = fetch): Promise<string | null> {
  const pages = await pagesFor(env.DB, p);
  if (!pages.length) return 'No page to read: the source is a social post or there is no link.';
  let why = 'The page has no main picture.';
  for (const page of pages) {
    const image = await pagePhoto(page, fetcher);
    if (!image) continue;
    if (NOT_A_PHOTO.test(new URL(image).pathname)) { why = 'The page picture looks like a logo.'; continue; }
    const used = await env.DB.prepare('SELECT COUNT(DISTINCT popup_id) AS n FROM popup_images WHERE origin_url = ?').bind(image).first<{ n: number }>();
    if ((used?.n ?? 0) >= SHARED_IMAGE_LIMIT) { why = 'The page picture is the same one other pop-ups use (a logo or default image).'; continue; }
    const src: PhotoSource = { imageUrl: image, pageUrl: page };
    const r = await addPhotoFromUrl(env, p.id, BOT_ID, src, now, fetcher);
    if (r.saved) return null;
    why = r.reason;
  }
  return why;
}

/**
 * One cron step. Picks the soonest-to-matter public pop-ups with no photo that nobody tried lately,
 * tries each, and records the answer. Returns how many got a photo.
 */
export async function backfillPhotos(env: Pick<Bindings, 'DB' | 'IMAGES'>, now: number, batch = BACKFILL_BATCH, fetcher: typeof fetch = fetch): Promise<number> {
  if (!env.IMAGES) return 0;
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.source_url FROM popups p
     WHERE p.status IN ('community', 'verified_community', 'verified_admin') AND p.end_at >= ?1
       AND NOT EXISTS (SELECT 1 FROM popup_images i WHERE i.popup_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM photo_tries t WHERE t.popup_id = p.id AND (t.saved = 1 OR t.tried_at > ?2))
     ORDER BY p.hot DESC LIMIT ?3`,
  ).bind(now, now - RETRY_AFTER, batch).all<Candidate>();
  if (!results.length) return 0;
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES (?, 'photo-bot@system.invalid', 'Photo backfill', 'user', 0, 0, ?)").bind(BOT_ID, now).run();
  let saved = 0;
  for (const p of results) {
    let why: string | null;
    try { why = await backfillOne(env, p, now, fetcher); } catch (e) { console.error('photo backfill failed', p.id, e); why = 'It could not be read.'; }
    if (!why) saved++;
    await env.DB.prepare('INSERT OR REPLACE INTO photo_tries (popup_id, tried_at, saved, reason) VALUES (?, ?, ?, ?)').bind(p.id, now, why ? 0 : 1, why).run();
  }
  return saved;
}
