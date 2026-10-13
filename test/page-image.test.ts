import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { bodyImage, imageSize, looksLikeAPhoto } from '../src/lib/page-image';
import { pagePhoto, pagePhotoResult } from '../src/lib/photo';
import { backfillPhotos } from '../src/db/photo-backfill';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 9);

/** A JPEG header with a real size in its SOF0 marker, padded to 5000 bytes. */
function jpegOf(width: number, height: number) {
  const b = new Uint8Array(5000);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return b;
}

describe('bodyImage', () => {
  const page = (body: string) => `<html><head><title>x</title></head><body><header><img src="/header-photo.jpg" width="900"></header>${body}</body></html>`;

  it('takes the first big picture after the main heading, not one from the header', () => {
    expect(bodyImage(page('<h1>Show</h1><img src="/show.jpg" width="900"><img src="/other.jpg">'))).toBe('/show.jpg');
  });

  it('needs a main heading, and stops at the footer', () => {
    expect(bodyImage(page('<h2>Show</h2><img src="/show.jpg">'))).toBeNull();
    expect(bodyImage(page('<h1>Show</h1><p>text</p><footer><img src="/footer.jpg"></footer>'))).toBeNull();
  });

  it('skips logos, icons, maps, tiny pictures, GIFs, SVGs and inline data', () => {
    const imgs = [
      '<img src="/site-logo.png">', '<img src="/icon-share.png">', '<img src="/img/gasworks-navigation-gmap.png">',
      '<img src="/small.jpg" width="120">', '<img src="/spinner.gif">', '<img src="/mark.svg">', '<img src="data:image/jpeg;base64,AAAA">',
      '<img class="avatar" src="/person.jpg">', '<img alt="Company logo" src="/co.jpg">',
    ].join('');
    expect(bodyImage(page(`<h1>Show</h1>${imgs}<img src="/real.jpg">`))).toBe('/real.jpg');
    expect(bodyImage(page(`<h1>Show</h1>${imgs}`))).toBeNull();
  });

  it('skips map pictures: Google static maps and tiles, and a name, class or alt that says map', () => {
    const maps = [
      '<img src="https://maps.googleapis.com/maps/api/staticmap?center=51.5,-0.1&zoom=15&size=800x400.jpg">',
      '<img src="https://maps.googleapis.com/gen_204/venue.jpg">', '<img src="https://maps.gstatic.com/mapfiles/pin.png">',
      '<img src="https://www.google.com/maps/vt/pb=abc/tile.png">', '<img src="https://img.test/staticmap.png">',
      '<img src="/img/venue_map.png">', '<img src="/img/find-us-map-large.jpg">', '<img class="map" src="/img/find-us.jpg">', '<img alt="Map of the venue" src="/img/find-us.jpg">',
      '<img alt="Google Map" src="/img/directions.jpg">',
    ].join('');
    expect(bodyImage(page(`<h1>Show</h1>${maps}`))).toBeNull();
    expect(bodyImage(page(`<h1>Show</h1>${maps}<img src="/real.jpg">`))).toBe('/real.jpg');
  });

  it('does not take "map" out of the middle of a word', () => {
    expect(bodyImage(page('<h1>Show</h1><img alt="Mapplethorpe: the photographs" src="/mapplethorpe-portrait.jpg">'))).toBe('/mapplethorpe-portrait.jpg');
    expect(bodyImage(page('<h1>Show</h1><img src="/img/roadmapping.jpg">'))).toBe('/img/roadmapping.jpg');
  });

  it('prefers the widest srcset entry and reads lazy-loaded pictures', () => {
    expect(bodyImage(page('<h1>Show</h1><img srcset="/a-300.jpg 300w, /a-1400.jpg 1400w, /a-750.jpg 750w" src="/a-125.jpg" width="125">'))).toBe('/a-1400.jpg');
    expect(bodyImage(page('<h1>Show</h1><img src="data:image/gif;base64,R0lG" data-src="/lazy.jpg">'))).toBe('/lazy.jpg');
  });

  it('looks at no more than 25 pictures', () => {
    const small = '<img src="/x.jpg" width="100">'.repeat(25);
    expect(bodyImage(page(`<h1>Show</h1>${small}<img src="/late.jpg">`))).toBeNull();
  });
});

describe('imageSize and looksLikeAPhoto', () => {
  it('reads the size from a JPEG header', () => {
    expect(imageSize(jpegOf(1739, 2175))).toEqual({ width: 1739, height: 2175 });
  });

  it('reads PNG and WebP headers, and gives null for anything else', () => {
    const png = new Uint8Array(40); png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0x80]);
    expect(imageSize(png)).toEqual({ width: 512, height: 384 });
    const webp = new Uint8Array(40); webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    webp.set([0x1f, 0x03, 0x00, 0x7f, 0x02, 0x00], 24); // width 800, height 640 (minus one each)
    expect(imageSize(webp)).toEqual({ width: 800, height: 640 });
    expect(imageSize(new Uint8Array(40))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('wants at least 400 x 250 and nothing stretched into a strip', () => {
    expect(looksLikeAPhoto({ width: 1739, height: 2175 })).toBe(true);
    expect(looksLikeAPhoto({ width: 800, height: 600 })).toBe(true);
    expect(looksLikeAPhoto({ width: 300, height: 250 })).toBe(false); // an ad box
    expect(looksLikeAPhoto({ width: 2560, height: 233 })).toBe(false); // a banner
    expect(looksLikeAPhoto({ width: 687, height: 211 })).toBe(false);
    expect(looksLikeAPhoto(null)).toBe(false);
  });
});

describe('pagePhotoResult with the body fallback', () => {
  const f = (h: string) => (async () => new Response(h, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const html = '<head><title>x</title></head><body><h1>Show</h1><img src="/show.jpg" width="900"></body>';

  it('is off unless asked, and the head and JSON-LD still come first', async () => {
    expect(await pagePhoto('https://shop.test/show', f(html))).toBeNull();
    expect(await pagePhotoResult('https://shop.test/show', f(html), { body: true })).toEqual({ image: 'https://shop.test/show.jpg', fromBody: true });
    expect(await pagePhotoResult('https://shop.test/show', f(`<head><meta property="og:image" content="/og.jpg"></head><body><h1>Show</h1><img src="/show.jpg" width="900"></body>`), { body: true })).toEqual({ image: 'https://shop.test/og.jpg' });
  });

  it('decodes &amp; in the address', async () => {
    const r = await pagePhotoResult('https://shop.test/show', f('<body><h1>Show</h1><img src="/s.jpg?a=1&amp;w=900" width="900"></body>'), { body: true });
    expect(r.image).toBe('https://shop.test/s.jpg?a=1&w=900');
  });
});

describe('the backfill with a body picture', () => {
  async function addPopup(id: string, source: string) {
    await env.DB.prepare(`INSERT INTO popups (id, slug, title, category, start_at, end_at, lat, lng, geohash, address, status, created_by, created_at, updated_at, source_url, is_example)
      VALUES (?, ?, ?, 'other', ?, ?, 51.5, -0.1, 'gcpvj', 'A', 'community', 'pi_user', ?, ?, ?, 0)`).bind(id, id, id, NOW, NOW + 90 * DAY, NOW, NOW, source).run();
  }
  const rows = async (id: string) => (await env.DB.prepare('SELECT origin_url FROM popup_images WHERE popup_id = ?').bind(id).all<any>()).results;
  const tried = (id: string) => env.DB.prepare('SELECT saved, reason FROM photo_tries WHERE popup_id = ?').bind(id).first<{ saved: number; reason: string | null }>();
  /** Page /p/N shows /N.jpg after its heading; the size of each picture is set per name. */
  const web = (sizes: Record<string, [number, number]>) => (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const name = url.pathname.split('/').pop()!;
    if (url.pathname.startsWith('/p/')) return new Response(`<head></head><body><h1>x</h1><img src="/${name}.jpg" width="900"></body>`, { headers: { 'content-type': 'text/html' } });
    const s = sizes[name];
    return s ? new Response(jpegOf(...s), { headers: { 'content-type': 'image/jpeg' } }) : new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  const go = async (f: typeof fetch) => { await env.DB.prepare("DELETE FROM settings WHERE key = 'photo_backfill'").run(); return backfillPhotos(env, NOW, 10, f); };

  beforeAll(async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('pi_user', 'pi_user@test.dev', ?)").bind(NOW).run();
  });

  it('saves a big picture from the body, refuses a banner, and does not give one picture to two pop-ups', async () => {
    await addPopup('pi_a', 'https://shop.test/p/good');
    await addPopup('pi_b', 'https://shop.test/p/strip');
    await addPopup('pi_c', 'https://shop.test/p/good2');
    const f = web({ 'good.jpg': [1200, 800], 'strip.jpg': [2560, 233], 'good2.jpg': [1200, 800] });
    expect(await go(f)).toBe(2);
    expect(await rows('pi_a')).toHaveLength(1);
    expect(await rows('pi_b')).toHaveLength(0);
    expect((await tried('pi_b'))!.reason).toMatch(/too small or a banner/);
    expect(await rows('pi_c')).toHaveLength(1);

    // a pop-up whose own page shows the very same picture does not get it (not even up to the usual two)
    await addPopup('pi_d', 'https://shop.test/p/other/good');
    expect(await go(f)).toBe(0);
    expect(await rows('pi_d')).toHaveLength(0);
    expect((await tried('pi_d'))!.reason).toMatch(/same one other pop-ups use/);
  });

  it('does not guess from the body when two pop-ups share one source address, but still takes a named og:image', async () => {
    // two shows, one venue home page: whatever the page shows first is not either show's own picture
    await addPopup('pi_h1', 'https://shop.test/p/home');
    await addPopup('pi_h2', 'https://shop.test/p/home');
    await addPopup('pi_own', 'https://shop.test/p/own'); // a page that belongs to one pop-up still works
    const f = web({ 'home.jpg': [1200, 800], 'own.jpg': [1200, 800] });
    expect(await go(f)).toBe(1);
    expect(await rows('pi_h1')).toHaveLength(0);
    expect(await rows('pi_h2')).toHaveLength(0);
    expect((await tried('pi_h1'))!.reason).toBe('The page has no main picture.');
    expect(await rows('pi_own')).toHaveLength(1);

    // a shared page that names its picture in the head (og:image) is not touched by the rule
    await addPopup('pi_o1', 'https://og.test/shows');
    await addPopup('pi_o2', 'https://og.test/shows');
    const og = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/shows') return new Response('<head><meta property="og:image" content="/hero.jpg"></head><body><h1>x</h1></body>', { headers: { 'content-type': 'text/html' } });
      return url.pathname === '/hero.jpg' ? new Response(jpegOf(1200, 800), { headers: { 'content-type': 'image/jpeg' } }) : new Response('no', { status: 404 });
    }) as unknown as typeof fetch;
    expect(await go(og)).toBe(2);
    expect(await rows('pi_o1')).toHaveLength(1);
    expect(await rows('pi_o2')).toHaveLength(1);
  });
});
