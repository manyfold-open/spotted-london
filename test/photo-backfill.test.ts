import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { backfillPhotos, RETRY_AFTER } from '../src/db/photo-backfill';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 13);
const jpeg = () => { const b = new Uint8Array(5000); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };

/** Pages that exist (page address to the og:image it names), and every .jpg loads. */
function web(pages: Record<string, string | null>) {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (/\.jpg$/.test(url)) return new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } });
    if (!(url in pages)) return new Response('no', { status: 404 });
    const og = pages[url];
    return new Response(`<head>${og ? `<meta property="og:image" content="${og}">` : ''}</head>`, { headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;
  return { f, asked };
}

async function addPopup(id: string, source: string | null, status = 'community') {
  await env.DB.prepare(`INSERT INTO popups (id, slug, title, category, start_at, end_at, lat, lng, geohash, address, status, created_by, created_at, updated_at, source_url, is_example)
    VALUES (?, ?, ?, 'other', ?, ?, 51.5, -0.1, 'gcpvj', 'A', ?, 'bf_user', ?, ?, ?, 0)`)
    .bind(id, id, id, NOW, NOW + 90 * DAY, status, NOW, NOW, source).run();
}
const photos = async (id: string) => (await env.DB.prepare('SELECT * FROM popup_images WHERE popup_id = ?').bind(id).all<any>()).results;
const tried = async (id: string) => env.DB.prepare('SELECT saved, reason FROM photo_tries WHERE popup_id = ?').bind(id).first<{ saved: number; reason: string | null }>();

describe('backfillPhotos', () => {
  beforeAll(async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('bf_user', 'bf_user@test.dev', ?)").bind(NOW).run();
  });

  it('copies the main picture of the source page, credits the page, and does not look again', async () => {
    await addPopup('bf_a', 'https://www.shop.test/sale');
    const { f, asked } = web({ 'https://www.shop.test/sale': 'https://cdn.shop.test/hero-a.jpg' });
    expect(await backfillPhotos(env, NOW, 10, f)).toBe(1);
    const rows = await photos('bf_a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credit: 'shop.test', source_url: 'https://www.shop.test/sale', origin_url: 'https://cdn.shop.test/hero-a.jpg' });
    expect(await tried('bf_a')).toMatchObject({ saved: 1, reason: null });
    asked.length = 0;
    expect(await backfillPhotos(env, NOW + DAY, 10, f)).toBe(0);
    expect(asked).toEqual([]);
  });

  it('skips social posts without fetching them, and says why', async () => {
    await addPopup('bf_ig', 'https://www.instagram.com/p/abc/');
    const { f, asked } = web({});
    expect(await backfillPhotos(env, NOW, 10, f)).toBe(0);
    expect(asked).toEqual([]);
    expect((await tried('bf_ig'))!.reason).toMatch(/social post|no link/);
  });

  it('falls back to another link the Scout saved', async () => {
    await addPopup('bf_link', 'https://empty.test/page');
    await env.DB.prepare("INSERT INTO popup_links (popup_id, url, kind, created_at) VALUES ('bf_link', 'https://brand.test/event', 'official', ?)").bind(NOW).run();
    const { f } = web({ 'https://empty.test/page': null, 'https://brand.test/event': 'https://cdn.brand.test/event-photo.jpg' });
    expect(await backfillPhotos(env, NOW, 10, f)).toBe(1);
    expect((await photos('bf_link'))[0]).toMatchObject({ credit: 'brand.test' });
  });

  it('refuses a logo and a picture that other pop-ups already carry', async () => {
    await addPopup('bf_logo', 'https://logo.test/e');
    for (const id of ['bf_s1', 'bf_s2', 'bf_s3']) await addPopup(id, `https://fest.test/${id}`);
    const { f } = web({
      'https://logo.test/e': 'https://logo.test/assets/Logo-Large.jpg',
      'https://fest.test/bf_s1': 'https://cdn.fest.test/banner.jpg',
      'https://fest.test/bf_s2': 'https://cdn.fest.test/banner.jpg',
      'https://fest.test/bf_s3': 'https://cdn.fest.test/banner.jpg',
    });
    await backfillPhotos(env, NOW, 10, f);
    expect(await photos('bf_logo')).toHaveLength(0);
    expect((await tried('bf_logo'))!.reason).toMatch(/logo/);
    const counts = await Promise.all(['bf_s1', 'bf_s2', 'bf_s3'].map(async id => (await photos(id)).length));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2); // the third one is left without
  });

  it('retries a failure only after two weeks, and never puts back a photo someone took down', async () => {
    await addPopup('bf_retry', 'https://later.test/e');
    expect(await backfillPhotos(env, NOW, 10, web({ 'https://later.test/e': null }).f)).toBe(0);
    const later = web({ 'https://later.test/e': 'https://cdn.later.test/p.jpg' });
    expect(await backfillPhotos(env, NOW + 13 * DAY, 10, later.f)).toBe(0);
    expect(later.asked).toEqual([]);
    expect(await backfillPhotos(env, NOW + RETRY_AFTER + DAY, 10, later.f)).toBe(1);
    // an admin removes it: it stays removed
    await env.DB.prepare('DELETE FROM popup_images WHERE popup_id = ?').bind('bf_retry').run();
    expect(await backfillPhotos(env, NOW + 40 * DAY, 10, later.f)).toBe(0);
    expect(await photos('bf_retry')).toHaveLength(0);
  });

  it('leaves pending pop-ups alone', async () => {
    await addPopup('bf_pending', 'https://pending.test/e', 'pending');
    const { f, asked } = web({ 'https://pending.test/e': 'https://cdn.pending.test/p.jpg' });
    await backfillPhotos(env, NOW, 10, f);
    expect(asked.filter(u => u.includes('pending.test'))).toEqual([]);
  });
});
