import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { backfillPhotos, IDLE_AFTER_LAP, isListingPage, RETRY_AFTER, RETRY_SOON, retryAfter, sharedSources } from '../src/db/photo-backfill';

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

/** A fresh walk: forget where the last run stopped, so each test starts from the first pop-up. */
async function run(now: number, batch: number, f: typeof fetch) {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'photo_backfill'").run();
  return backfillPhotos(env, now, batch, f);
}

describe('backfillPhotos', () => {
  beforeAll(async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('bf_user', 'bf_user@test.dev', ?)").bind(NOW).run();
  });

  it('copies the main picture of the source page, credits the page, and does not look again', async () => {
    await addPopup('bf_a', 'https://www.shop.test/sale');
    const { f, asked } = web({ 'https://www.shop.test/sale': 'https://cdn.shop.test/hero-a.jpg' });
    expect(await run(NOW, 10, f)).toBe(1);
    const rows = await photos('bf_a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credit: 'shop.test', source_url: 'https://www.shop.test/sale', origin_url: 'https://cdn.shop.test/hero-a.jpg' });
    expect(await tried('bf_a')).toMatchObject({ saved: 1, reason: null });
    asked.length = 0;
    expect(await run(NOW + DAY, 10, f)).toBe(0);
    expect(asked).toEqual([]);
  });

  it('skips social posts without fetching them, and says why', async () => {
    await addPopup('bf_ig', 'https://www.instagram.com/p/abc/');
    const { f, asked } = web({});
    expect(await run(NOW, 10, f)).toBe(0);
    expect(asked).toEqual([]);
    expect((await tried('bf_ig'))!.reason).toMatch(/social post|no link/);
  });

  it('falls back to another link the Scout saved', async () => {
    await addPopup('bf_link', 'https://empty.test/page');
    await env.DB.prepare("INSERT INTO popup_links (popup_id, url, kind, created_at) VALUES ('bf_link', 'https://brand.test/event', 'official', ?)").bind(NOW).run();
    const { f } = web({ 'https://empty.test/page': null, 'https://brand.test/event': 'https://cdn.brand.test/event-photo.jpg' });
    expect(await run(NOW, 10, f)).toBe(1);
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
    await run(NOW, 10, f);
    expect(await photos('bf_logo')).toHaveLength(0);
    expect((await tried('bf_logo'))!.reason).toMatch(/logo/);
    const counts = await Promise.all(['bf_s1', 'bf_s2', 'bf_s3'].map(async id => (await photos(id)).length));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2); // the third one is left without
  });

  it('stores why a page gave no photo: refused, or really no picture', async () => {
    await addPopup('why_404', 'https://gone.test/e');
    await addPopup('why_none', 'https://bare.test/e');
    expect(await run(NOW, 10, web({ 'https://bare.test/e': null }).f)).toBe(0);
    expect((await tried('why_404'))!.reason).toBe('The page answered HTTP 404.');
    expect((await tried('why_none'))!.reason).toBe('The page has no main picture.');
  });

  it('retries a failure only after two weeks, and never puts back a photo someone took down', async () => {
    await addPopup('bf_retry', 'https://later.test/e');
    expect(await run(NOW, 10, web({ 'https://later.test/e': null }).f)).toBe(0);
    const later = web({ 'https://later.test/e': 'https://cdn.later.test/p.jpg' });
    expect(await run(NOW + 13 * DAY, 10, later.f)).toBe(0);
    expect(later.asked).toEqual([]);
    expect(await run(NOW + RETRY_AFTER + DAY, 10, later.f)).toBe(1);
    // an admin removes it: it stays removed
    await env.DB.prepare('DELETE FROM popup_images WHERE popup_id = ?').bind('bf_retry').run();
    expect(await run(NOW + 40 * DAY, 10, later.f)).toBe(0);
    expect(await photos('bf_retry')).toHaveLength(0);
  });

  it('retries a page that did not load after three days, not two weeks', async () => {
    await addPopup('bf_down', 'https://down.test/e');
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    expect(await run(NOW, 10, down)).toBe(0);
    expect((await tried('bf_down'))!.reason).toBe('The page answered HTTP 503.');
    const up = web({ 'https://down.test/e': 'https://cdn.down.test/p.jpg' });
    expect(await run(NOW + 2 * DAY, 10, up.f)).toBe(0);
    expect(up.asked).toEqual([]);
    expect(await run(NOW + RETRY_SOON + 1, 10, up.f)).toBe(1);
  });

  it('waits three days only for reasons that can pass', () => {
    for (const why of ['The page took longer than 5 seconds to load.', 'The page did not load.', 'The page could not be read.', 'It could not be read.', 'The page answered HTTP 502.', 'The page answered HTTP 429.', 'The photo did not load.', 'The site did not give us the photo.'])
      expect(retryAfter(why), why).toBe(RETRY_SOON);
    for (const why of ['The page has no main picture.', 'The page answered HTTP 403.', 'The page answered HTTP 404.', 'The page picture looks like a logo.', 'The photo is bigger than 5 MB.', 'Photos must be JPEG, PNG or WebP.'])
      expect(retryAfter(why), why).toBe(RETRY_AFTER);
  });

  it('leaves pending pop-ups alone', async () => {
    await addPopup('bf_pending', 'https://pending.test/e', 'pending');
    const { f, asked } = web({ 'https://pending.test/e': 'https://cdn.pending.test/p.jpg' });
    await run(NOW, 10, f);
    expect(asked.filter(u => u.includes('pending.test'))).toEqual([]);
  });

  it('walks the pop-ups a few at a time from a cursor, rests after a lap, and picks up new ones later', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'photo_backfill'").run();
    await env.DB.prepare("UPDATE popups SET status = 'removed' WHERE id LIKE 'bf_%'").run(); // only this test's pop-ups count
    const ids = ['cur_1', 'cur_2', 'cur_3', 'cur_4', 'cur_5'];
    for (const id of ids) await addPopup(id, `https://cur.test/${id}`);
    const { f } = web(Object.fromEntries(ids.map(id => [`https://cur.test/${id}`, `https://cdn.cur.test/${id}.jpg`])));
    const has = async () => (await Promise.all(ids.map(async id => (await photos(id)).length))).join('');
    expect(await backfillPhotos(env, NOW, 2, f)).toBe(2);
    expect(await has()).toBe('11000'); // the next run carries on after cur_2
    expect(await backfillPhotos(env, NOW + 600_000, 2, f)).toBe(2);
    expect(await has()).toBe('11110');
    expect(await backfillPhotos(env, NOW + 1_200_000, 2, f)).toBe(1); // fewer than asked for: the lap is done
    expect(await has()).toBe('11111');
    await addPopup('cur_6', 'https://cur.test/cur_6');
    const more = web({ 'https://cur.test/cur_6': 'https://cdn.cur.test/cur_6.jpg' });
    expect(await backfillPhotos(env, NOW + 1_800_000, 2, more.f)).toBe(0); // resting
    expect(more.asked).toEqual([]);
    expect(await backfillPhotos(env, NOW + 1_200_000 + IDLE_AFTER_LAP, 2, more.f)).toBe(1);
  });

  it('uses indexes: no full scan of popup_images or photo_tries', async () => {
    const plan = async (sql: string, ...args: unknown[]) =>
      (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map(r => r.detail).join(' | ');
    expect(await plan('SELECT COUNT(DISTINCT popup_id) AS n FROM popup_images WHERE origin_url = ?', 'x')).toMatch(/idx_images_origin/);
    const candidates = await plan(`SELECT p.id FROM popups p WHERE p.id > ?1 AND p.status IN ('community') AND p.end_at >= ?2
      AND NOT EXISTS (SELECT 1 FROM popup_images i WHERE i.popup_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM photo_tries t WHERE t.popup_id = p.id AND (t.saved = 1 OR t.retry_at > ?2)) ORDER BY p.id LIMIT 5`, '', 0);
    expect(candidates).not.toMatch(/SCAN (i|t|popup_images|photo_tries)\b/);
  });

  it('tells a list of many events from a page about one', () => {
    for (const u of ['https://gallery.test/exhibitions', 'https://gallery.test/exhibitions/', 'https://www.museum.test/whats-on/', 'https://venue.test/en/events?page=2', 'https://nt.test/visit/london/ham-house/events'])
      expect(isListingPage(u), u).toBe(true);
    for (const u of ['https://gallery.test/exhibitions/643-peter-howson-salvation/', 'https://venue.test/events/halloween-late', 'https://shop.test/', 'https://shop.test/sale', 'not a url'])
      expect(isListingPage(u), u).toBe(false);
  });

  it('knows which source links more than one pop-up uses, in one query, ignoring removed ones', async () => {
    await env.DB.prepare("UPDATE popups SET status = 'removed' WHERE id LIKE 'bf_%' OR id LIKE 'cur_%' OR id LIKE 'lst_%'").run();
    await addPopup('sh_1', 'https://venue.test/');
    await addPopup('sh_2', 'https://venue.test/');
    await addPopup('sh_3', 'https://venue.test/show-3');
    await addPopup('sh_4', 'https://gone.example/', 'removed');
    await addPopup('sh_5', 'https://gone.example/');
    const shared = await sharedSources(env.DB, ['https://venue.test/', 'https://venue.test/show-3', 'https://gone.example/', null, 'https://never.test/']);
    expect([...shared]).toEqual(['https://venue.test/']);
    expect((await sharedSources(env.DB, [null])).size).toBe(0);
  });

  it('does not use the body picture of a page that two pop-ups share, but does use its og:image', async () => {
    await env.DB.prepare("UPDATE popups SET status = 'removed' WHERE id LIKE 'sh_%'").run();
    await addPopup('own_1', 'https://twin.test/');
    await addPopup('own_2', 'https://twin.test/');
    await addPopup('own_3', 'https://solo.test/');
    const bodyOnly = (u: string) => new Response(`<head></head><body><h1>x</h1><img src="/${u}.jpg" width="900"></body>`, { headers: { 'content-type': 'text/html' } });
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('.jpg')) { const b = new Uint8Array(5000); b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 0x20, 4, 0xb0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]); return new Response(b, { headers: { 'content-type': 'image/jpeg' } }); }
      return url.hostname === 'twin.test' ? bodyOnly('twin') : bodyOnly('solo');
    }) as unknown as typeof fetch;
    expect(await run(NOW, 10, f)).toBe(1);
    expect(await photos('own_1')).toHaveLength(0);
    expect(await photos('own_2')).toHaveLength(0);
    expect(await photos('own_3')).toHaveLength(1);
  });

  it('does not read a list page, and says why', async () => {
    await env.DB.prepare("UPDATE popups SET status = 'removed' WHERE id LIKE 'bf_%' OR id LIKE 'cur_%'").run();
    await addPopup('lst_1', 'https://gallery.test/exhibitions');
    const { f, asked } = web({ 'https://gallery.test/exhibitions': 'https://cdn.gallery.test/default.jpg' });
    expect(await run(NOW, 10, f)).toBe(0);
    expect(asked).toEqual([]);
    expect((await tried('lst_1'))!.reason).toMatch(/list of many events/);
  });
});
