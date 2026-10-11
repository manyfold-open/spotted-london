// Real photos for pop-ups that have none: copy the main picture of the page or post the pop-up came from
// into our own R2 bucket (never hotlink: Instagram addresses expire), and credit the page.
// Used by the paste-a-link form (POST /popups/:id/images/from-url) and by the Scout's submit_draft.

import { safeUrl, parseOpenGraph } from './extract';
import { newId } from './util';

export const MAX_PHOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 3000; // below this it is a tracking pixel or an icon, not a photo
const MAX_HTML = 500_000; // some pages inline 400 KB of CSS before the meta tags end
const UA = 'SpottedLondonBot/0.1 (+https://spotted.london/bot)';

export class PhotoError extends Error {}

export type PhotoType = { type: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

/** What the bytes really are. The server's content-type header is not trusted. */
export function sniffPhoto(b: Uint8Array): PhotoType | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: 'image/webp', ext: 'webp' };
  return null;
}

/** "Photo: example.com" for a page address. */
export function creditFor(pageUrl: string | null | undefined): string | null {
  const u = pageUrl ? safeUrl(pageUrl) : null;
  return u ? u.hostname.replace(/^www\./, '') : null;
}

/** An address found in a page (maybe relative) turned into a public https/http address. */
export function resolveImageUrl(raw: string | null | undefined, page: string): string | null {
  if (!raw) return null;
  try { return safeUrl(new URL(raw.trim(), page).toString())?.toString() ?? null; } catch { return null; }
}

export async function fetchPhoto(raw: string, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array } & PhotoType> {
  const url = safeUrl(raw);
  if (!url) throw new PhotoError('The photo address is not a public web link.');
  let res: Response;
  try {
    res = await fetcher(url.toString(), { headers: { 'user-agent': UA, accept: 'image/jpeg,image/png,image/webp,image/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  } catch { throw new PhotoError('The photo did not load.'); }
  const length = Number(res.headers.get('content-length') ?? 0);
  if (!res.ok || !res.body) { await res.body?.cancel(); throw new PhotoError('The site did not give us the photo.'); }
  if (length > MAX_BYTES) { await res.body.cancel(); throw new PhotoError('The photo is bigger than 5 MB.'); }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new PhotoError('The photo is bigger than 5 MB.'); }
    chunks.push(value);
  }
  if (size < MIN_BYTES) throw new PhotoError('That picture is too small to be a photo.');
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  const kind = sniffPhoto(bytes);
  if (!kind) throw new PhotoError('Photos must be JPEG, PNG or WebP.');
  return { bytes, ...kind };
}

/**
 * The main picture a page names (og:image, twitter:image), as an absolute address, or why there is none.
 * The reason tells "the site refused us" (HTTP 403) from "the page has no picture", which the backfill stores.
 */
export async function pagePhotoResult(pageUrl: string, fetcher: typeof fetch = fetch): Promise<{ image: string; why?: undefined } | { image: null; why: string }> {
  const page = safeUrl(pageUrl);
  if (!page) return { image: null, why: 'The page address is not a public web link.' };
  let res: Response;
  try {
    res = await fetcher(page.toString(), { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
  } catch (e) {
    return { image: null, why: e instanceof Error && /timeout|abort/i.test(e.name) ? 'The page took longer than 5 seconds to load.' : 'The page did not load.' };
  }
  try {
    if (!res.ok || !res.body) { await res.body?.cancel(); return { image: null, why: `The page answered HTTP ${res.status}.` }; }
    const type = res.headers.get('content-type') ?? '';
    if (!/html/i.test(type)) { await res.body.cancel(); return { image: null, why: `The page is not a web page (${type.split(';')[0] || 'no type'}).` }; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < MAX_HTML) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const from = Math.max(0, html.length - 6);
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html.slice(from))) break; // the meta tags are in the head
    }
    await reader.cancel().catch(() => {});
    const end = html.search(/<\/head>/i);
    const raw = parseOpenGraph(end >= 0 ? html.slice(0, end) : html).image_url;
    if (!raw) return { image: null, why: 'The page has no main picture.' };
    const image = resolveImageUrl(raw, page.toString());
    return image ? { image } : { image: null, why: 'The page names a picture that is not a public web link.' };
  } catch { return { image: null, why: 'The page could not be read.' }; }
}

/** Just the address (see pagePhotoResult). Null when the page cannot be read or has no picture. */
export async function pagePhoto(pageUrl: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  return (await pagePhotoResult(pageUrl, fetcher)).image;
}

export type PhotoSource = { imageUrl: string; pageUrl: string | null };

/**
 * Copy one photo into R2 and the popup_images table. Returns the stored photo, or says why not.
 * Skips quietly when the pop-up already has 5 photos or this picture is already on it.
 */
export async function addPhotoFromUrl(
  env: { DB: D1Database; IMAGES?: R2Bucket },
  popupId: string,
  userId: string,
  src: PhotoSource,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<{ saved: true; id: string; url: string } | { saved: false; reason: string }> {
  if (!env.IMAGES) return { saved: false, reason: 'Photo storage is not switched on.' };
  const have = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(origin_url = ?2) AS same FROM popup_images WHERE popup_id = ?1').bind(popupId, src.imageUrl).first<{ n: number; same: number | null }>();
  if ((have?.same ?? 0) > 0) return { saved: false, reason: 'That photo is already on the pop-up.' };
  if ((have?.n ?? 0) >= MAX_PHOTOS) return { saved: false, reason: `A pop-up can have up to ${MAX_PHOTOS} photos.` };
  let photo: Awaited<ReturnType<typeof fetchPhoto>>;
  try { photo = await fetchPhoto(src.imageUrl, fetcher); } catch (e) { return { saved: false, reason: e instanceof PhotoError ? e.message : 'The photo could not be read.' }; }
  const id = newId();
  const key = `popups/${popupId}/${id}.${photo.ext}`;
  await env.IMAGES.put(key, photo.bytes, { httpMetadata: { contentType: photo.type, cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare('INSERT INTO popup_images (id, popup_id, r2_key, position, uploaded_by, created_at, source_url, credit, origin_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, popupId, key, have?.n ?? 0, userId, now, src.pageUrl, creditFor(src.pageUrl), src.imageUrl).run();
  return { saved: true, id, url: `/api/v1/images/${key}` };
}
