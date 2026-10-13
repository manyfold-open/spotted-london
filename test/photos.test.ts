import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { creditFor, fetchPhoto, pagePhoto, pagePhotoResult, resolveImageUrl, sniffPhoto } from '../src/lib/photo';

const NOW = Date.UTC(2026, 8, 30, 13);
const DAY = 86_400_000;
const jpeg = () => { const b = new Uint8Array(5000); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const png = () => { const b = new Uint8Array(5000); b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]); return b; };
const webp = () => { const b = new Uint8Array(5000); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); return b; };

afterEach(() => vi.restoreAllMocks());

describe('photo helpers', () => {
  it('reads the real type from the bytes', () => {
    expect(sniffPhoto(jpeg())?.ext).toBe('jpg');
    expect(sniffPhoto(png())?.ext).toBe('png');
    expect(sniffPhoto(webp())?.ext).toBe('webp');
    expect(sniffPhoto(new Uint8Array(5000).fill(60))).toBeNull(); // html or text served as an image
  });

  it('credits the site name and resolves relative addresses against the page', () => {
    expect(creditFor('https://www.example.com/a/b')).toBe('example.com');
    expect(creditFor('not a url')).toBeNull();
    expect(resolveImageUrl('/img/a.jpg', 'https://shop.test/x/y')).toBe('https://shop.test/img/a.jpg');
    expect(resolveImageUrl('//cdn.test/a.jpg', 'https://shop.test/')).toBe('https://cdn.test/a.jpg');
    expect(resolveImageUrl('http://127.0.0.1/a.jpg', 'https://shop.test/')).toBeNull();
    expect(resolveImageUrl('javascript:alert(1)', 'https://shop.test/')).toBeNull();
    expect(resolveImageUrl(null, 'https://shop.test/')).toBeNull();
  });

  it('fetchPhoto accepts a real photo and refuses big, tiny, wrong and failed ones', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch;
    expect((await fetchPhoto('https://a.test/p.jpg', f(new Response(jpeg(), { headers: { 'content-type': 'application/octet-stream' } })))).type).toBe('image/jpeg');
    await expect(fetchPhoto('https://a.test/p.jpg', f(new Response(new Uint8Array(6 * 1024 * 1024))))).rejects.toThrow(/5 MB/);
    await expect(fetchPhoto('https://a.test/p.jpg', f(new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]))))).rejects.toThrow(/too small/);
    await expect(fetchPhoto('https://a.test/p.jpg', f(new Response(new Uint8Array(5000).fill(60))))).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(fetchPhoto('https://a.test/p.jpg', f(new Response('no', { status: 403 })))).rejects.toThrow(/did not give/);
    await expect(fetchPhoto('https://localhost/p.jpg')).rejects.toThrow(/public web link/);
  });

  it('pagePhoto finds the og:image, also a relative one, and gives null for a page it cannot read', async () => {
    const html = (h: string) => (async () => new Response(h, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await pagePhoto('https://shop.test/sale', html('<head><meta property="og:image" content="/hero.jpg"></head>'))).toBe('https://shop.test/hero.jpg');
    expect(await pagePhoto('https://shop.test/sale', html('<head><title>x</title></head>'))).toBeNull();
    expect(await pagePhoto('https://shop.test/sale', (async () => new Response('no', { status: 403 })) as unknown as typeof fetch)).toBeNull();
  });

  it('pagePhotoResult says why a page gave no picture', async () => {
    const page = (body: BodyInit | null, init: ResponseInit = { headers: { 'content-type': 'text/html' } }) => (async () => new Response(body, init)) as unknown as typeof fetch;
    const why = async (f: typeof fetch) => (await pagePhotoResult('https://shop.test/sale', f)).why;
    expect(await why(page('no', { status: 403 }))).toBe('The page answered HTTP 403.');
    expect(await why(page('x', { headers: { 'content-type': 'application/pdf' } }))).toMatch(/not a web page \(application\/pdf\)/);
    expect(await why(page('<head><title>x</title></head>'))).toBe('The page has no main picture.');
    expect(await why(page('<head><meta property="og:image" content=""></head>'))).toBe('The page has no main picture.');
    expect(await why(page('<head><meta property="og:image" content="http://localhost:3000/social.png"></head>'))).toMatch(/not a public web link/);
    expect(await why((async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch)).toMatch(/longer than 5 seconds/);
    expect(await why((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).toBe('The page did not load.');
    expect(await pagePhotoResult('https://shop.test/sale', page('<head><meta property="og:image" content="/hero.jpg"></head>'))).toEqual({ image: 'https://shop.test/hero.jpg' });
  });

  it('falls back to the image of a JSON-LD Event, also in the body, but not an Organization logo', async () => {
    const f = (h: string) => (async () => new Response(h, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    const org = ld({ '@type': 'Organization', logo: '/logo.png', image: '/brand.jpg' });
    expect(await pagePhoto('https://shop.test/sale', f(`<head>${org}</head><body>${ld({ '@type': 'ExhibitionEvent', image: '/show.jpg' })}</body>`))).toBe('https://shop.test/show.jpg');
    expect(await pagePhoto('https://shop.test/sale', f(`<head></head><body>${ld({ '@graph': [{ '@type': 'Event', image: [{ '@type': 'ImageObject', url: 'https://cdn.shop.test/a.jpg' }] }] })}</body>`))).toBe('https://cdn.shop.test/a.jpg');
    expect(await pagePhoto('https://shop.test/sale', f(`<head>${org}</head><body></body>`))).toBeNull();
    // the National Gallery writes the plus in the type as an entity, and &amp; inside the JSON
    const ng = '<script type="application/ld&#x2B;json">{"@type":"Event","image":"https://www.ng.test/media/renoir.jpg?rmode=crop&amp;width=800"}</script>';
    expect(await pagePhoto('https://www.ng.test/exhibitions/renoir', f(`<head></head><body>${ng}</body>`))).toBe('https://www.ng.test/media/renoir.jpg?rmode=crop&width=800');
    // the og:image in the head still wins
    expect(await pagePhoto('https://shop.test/sale', f(`<head><meta property="og:image" content="/og.jpg"></head><body>${ld({ '@type': 'Event', image: '/show.jpg' })}</body>`))).toBe('https://shop.test/og.jpg');
  });

  it('falls back to link image_src, itemprop image and name thumbnail in the head, after og:image', async () => {
    const f = (h: string) => (async () => new Response(h, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const at = (head: string) => pagePhoto('https://shop.test/sale', f(`<head>${head}</head>`));
    expect(await at('<link rel="image_src" href="/a.jpg">')).toBe('https://shop.test/a.jpg');
    expect(await at('<meta itemprop="image" content="/b.jpg">')).toBe('https://shop.test/b.jpg');
    expect(await at("<meta content='/c.jpg' name='thumbnail'>")).toBe('https://shop.test/c.jpg');
    expect(await at('<meta property="og:image" content="/og.jpg"><link rel="image_src" href="/a.jpg">')).toBe('https://shop.test/og.jpg');
    // not a picture of the page: icons, other meta names
    expect(await at('<link rel="icon" href="/fav.png"><meta name="msapplication-TileImage" content="/tile.png"><meta name="description" content="image">')).toBeNull();
  });

  it('fetchPhoto does not ask for image/* (sites then answer with AVIF)', async () => {
    let accept = '';
    const f = (async (_u: string, init: RequestInit) => { accept = new Headers(init.headers).get('accept') ?? ''; return new Response(jpeg()); }) as unknown as typeof fetch;
    await fetchPhoto('https://a.test/p.jpg', f);
    expect(accept).not.toContain('*');
  });

  it('pagePhoto reads past 300 KB of inline CSS to the meta tags, and ignores meta tags in the body', async () => {
    const f = (h: string) => (async () => new Response(h, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const css = `<style>${'a{color:red}'.repeat(30_000)}</style>`; // 360 KB
    expect(css.length).toBeGreaterThan(300_000);
    expect(await pagePhoto('https://shop.test/sale', f(`<head>${css}<meta property="og:image" content="/late.jpg"></head><body></body>`))).toBe('https://shop.test/late.jpg');
    expect(await pagePhoto('https://shop.test/sale', f('<head><title>x</title></head><body><meta property="og:image" content="/body.jpg"></body>'))).toBeNull();
  });
});

async function call(path: string, user?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-now', String(NOW));
  if (user) headers.set('x-dev-user', user);
  return exports.default.fetch(new Request(`http://spotted.test${path}`, { ...init, headers }));
}
let n = 0;
async function user(role = 'user') {
  const id = `ph${++n}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare('INSERT INTO users (id, email, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, 58, 3, 1, ?)')
    .bind(id, `${id}@test.dev`, role, NOW - 60 * DAY).run();
  return id;
}
async function popup(u: string) {
  const res = await call('/api/v1/popups', u, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `Photo stall ${Math.random().toString(36).slice(2, 8)}`, category: 'market', lat: 51.53 + Math.random() / 50, lng: -0.07, start_at: NOW + DAY, end_at: NOW + 2 * DAY, source_url: 'https://example.com/x' }),
  });
  return (await res.json()) as { id: string; slug: string };
}
const post = (path: string, u: string, body: unknown) => call(path, u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /popups/:id/images/from-url', () => {
  it('copies the picture of the pasted link, credits the page, and shows the credit on the pop-up', async () => {
    const poster = await user(), p = await popup(poster);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png(), { headers: { 'content-type': 'image/png' } }));
    const r = await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: '/og.png', page_url: 'https://www.shop.test/sale' });
    expect(r.status).toBe(201);
    const again = await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: '/og.png', page_url: 'https://www.shop.test/sale' });
    expect(again.status).toBe(422); // the same picture twice
    const detail = (await (await call(`/api/v1/popups/${p.id}`, poster)).json()) as any;
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0]).toMatchObject({ credit: 'shop.test', credit_url: 'https://www.shop.test/sale' });
    expect(detail.cover_url).toBe(detail.images[0].url);
  });

  it('shows the photo on the Saved and My pop-ups lists too', async () => {
    const poster = await user(), p = await popup(poster);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png(), { headers: { 'content-type': 'image/png' } }));
    expect((await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: '/cover.png', page_url: 'https://www.shop.test/sale' })).status).toBe(201);
    expect((await call(`/api/v1/popups/${p.id}/save`, poster, { method: 'PUT' })).status).toBeLessThan(300);
    const saved = (await (await call('/api/v1/me/saves', poster)).json()) as { items: { id: string; cover_url: string | null }[] };
    expect(saved.items.find(i => i.id === p.id)?.cover_url).toMatch(/\/images\/popups\//);
    const mine = (await (await call('/api/v1/me/popups', poster)).json()) as { items: { id: string; cover_url: string | null }[] };
    expect(mine.items.find(i => i.id === p.id)?.cover_url).toMatch(/\/images\/popups\//);
  });

  it('is for the poster only, and refuses a private address', async () => {
    const poster = await user(), other = await user(), p = await popup(poster);
    expect((await post(`/api/v1/popups/${p.id}/images/from-url`, other, { image_url: 'https://cdn.test/a.jpg', page_url: 'https://shop.test/' })).status).toBe(403);
    expect((await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: 'http://127.0.0.1/a.jpg', page_url: 'https://shop.test/' })).status).toBe(400);
  });

  it('stops at 5 photos', async () => {
    const poster = await user(), p = await popup(poster);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } }));
    for (let i = 0; i < 5; i++) expect((await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: `https://cdn.test/${i}.jpg`, page_url: 'https://shop.test/' })).status).toBe(201);
    expect((await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: 'https://cdn.test/6.jpg', page_url: 'https://shop.test/' })).status).toBe(422);
  });
});

describe('DELETE /popups/:id/images/:imageId', () => {
  it('lets the poster or an admin take a photo down, keeps the others in order, and refuses anyone else', async () => {
    const poster = await user(), admin = await user('admin'), other = await user(), p = await popup(poster);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } }));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(((await (await post(`/api/v1/popups/${p.id}/images/from-url`, poster, { image_url: `https://cdn.test/d${i}.jpg`, page_url: 'https://shop.test/' })).json()) as any).id);
    expect((await call(`/api/v1/popups/${p.id}/images/${ids[0]}`, other, { method: 'DELETE' })).status).toBe(403);
    expect((await call(`/api/v1/popups/${p.id}/images/${ids[0]}`, admin, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/v1/popups/${p.id}/images/${ids[1]}`, poster, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/v1/popups/${p.id}/images/${ids[1]}`, poster, { method: 'DELETE' })).status).toBe(404);
    const rows = (await env.DB.prepare('SELECT id, position FROM popup_images WHERE popup_id = ?').bind(p.id).all<any>()).results;
    expect(rows).toEqual([{ id: ids[2], position: 0 }]);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'popup.image_remove' AND target_id = ?").bind(p.id).first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });
});
