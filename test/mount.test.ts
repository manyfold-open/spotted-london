import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import { isUnder, mountPath, PREFIX_HEADER, prefixed, withMount } from '../src/mount';

const MOUNT = '/spotted-london';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('mount path', () => {
  it('accepts plain path segments and nothing else', () => {
    expect(mountPath({ BASE_PATH: '/spotted-london' })).toBe('/spotted-london');
    expect(mountPath({ BASE_PATH: '/spotted-london/' })).toBe('/spotted-london');
    expect(mountPath({ BASE_PATH: ' /a/b ' })).toBe('/a/b');
    for (const bad of [undefined, '', '/', 'spotted', '/a b', '/"><script>', '//x', '/a//b']) expect(mountPath({ BASE_PATH: bad })).toBe('');
  });

  it('knows what is under the mount', () => {
    expect(isUnder('/spotted-london', MOUNT)).toBe(true);
    expect(isUnder('/spotted-london/api/v1/health', MOUNT)).toBe(true);
    expect(isUnder('/spotted-londonfoo', MOUNT)).toBe(false);
    expect(isUnder('/other/spotted-london', MOUNT)).toBe(false);
    expect(isUnder('/anything', '')).toBe(false);
  });

  it('prefixes root paths only', () => {
    expect(prefixed('/assets/a.js', MOUNT)).toBe('/spotted-london/assets/a.js');
    expect(prefixed('//cdn.example/x.js', MOUNT)).toBe('//cdn.example/x.js');
    expect(prefixed('https://example.com/x', MOUNT)).toBe('https://example.com/x');
    expect(prefixed('relative/path', MOUNT)).toBe('relative/path');
  });
});

describe('withMount', () => {
  const seen: Request[] = [];
  const inner = withMount<{ BASE_PATH?: string }>(async request => {
    seen.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/go') return new Response(null, { status: 302, headers: { location: '/saved' } });
    if (path === '/away') return new Response(null, { status: 302, headers: { location: 'https://example.com/saved' } });
    if (path === '/page') {
      return new Response(
        '<html><head><link rel="icon" href="/favicon.svg"><script src="/assets/a.js"></script></head><body>' +
        '<a href="/p/x">x</a><a href="//cdn.example/y">y</a><a href="https://example.com/z">z</a><a href="relative">r</a>' +
        '<form action="/login/verify"></form></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    if (path === '/tagged') return new Response('<head></head><a href="/p/x">x</a>', { headers: { 'content-type': 'text/html', etag: '"abc"' } });
    if (path === '/gone') return new Response('<a href="/p/x">x</a>', { status: 404, headers: { 'content-type': 'text/html' } });
    if (path === '/data') return Response.json({ url: '/api/v1/images/a.jpg' });
    return Response.json({ path });
  });
  const mounted = { BASE_PATH: MOUNT };
  const call = async (path: string, env: { BASE_PATH?: string } = mounted, init: RequestInit = {}) =>
    inner(new Request(`https://app.test${path}`, { redirect: 'manual', ...init }), env, ctx);

  it('serves the root untouched when there is no mount', async () => {
    const res = await call('/page', {});
    const text = await res.text();
    expect(text).toContain('href="/favicon.svg"');
    expect(text).not.toContain('app-base');
    expect((await call('/data', {}).then(r => r.json())) as { url: string }).toEqual({ url: '/api/v1/images/a.jpg' });
  });

  it('still serves the root when a mount is set, and forgets a prefix header a client made up', async () => {
    const res = await call('/data', mounted, { headers: { [PREFIX_HEADER]: '/evil' } });
    expect(res.status).toBe(200);
    expect(seen.at(-1)!.headers.has(PREFIX_HEADER)).toBe(false);
    expect(new URL(seen.at(-1)!.url).pathname).toBe('/data');
  });

  it('takes the prefix off on the way in and records it', async () => {
    const res = await call(`${MOUNT}/api/v1/health`);
    expect(await res.json()).toEqual({ path: '/api/v1/health' });
    expect(seen.at(-1)!.headers.get(PREFIX_HEADER)).toBe(MOUNT);
  });

  it('overwrites a prefix header sent by a client', async () => {
    await call(`${MOUNT}/data`, mounted, { headers: { [PREFIX_HEADER]: '/evil' } });
    expect(seen.at(-1)!.headers.get(PREFIX_HEADER)).toBe(MOUNT);
  });

  it('gives the front page one address, with the slash and the query', async () => {
    const res = await call(`${MOUNT}?ref=x`);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://app.test${MOUNT}/?ref=x`);
  });

  it('does not treat a lookalike path as the mount', async () => {
    const res = await call('/spotted-londonfoo/api');
    expect(await res.json()).toEqual({ path: '/spotted-londonfoo/api' });
  });

  it('puts the prefix back on a redirect, but not on another site', async () => {
    expect((await call(`${MOUNT}/go`)).headers.get('location')).toBe(`${MOUNT}/saved`);
    expect((await call(`${MOUNT}/away`)).headers.get('location')).toBe('https://example.com/saved');
  });

  it('rewrites root paths in an HTML page and says where it is mounted', async () => {
    const text = await (await call(`${MOUNT}/page`)).text();
    expect(text).toContain(`<meta name="app-base" content="${MOUNT}">`);
    expect(text).toContain(`href="${MOUNT}/favicon.svg"`);
    expect(text).toContain(`src="${MOUNT}/assets/a.js"`);
    expect(text).toContain(`href="${MOUNT}/p/x"`);
    expect(text).toContain(`action="${MOUNT}/login/verify"`);
    expect(text).toContain('href="//cdn.example/y"');
    expect(text).toContain('href="https://example.com/z"');
    expect(text).toContain('href="relative"');
  });

  it('does not keep the ETag of the original file on the rewritten page', async () => {
    expect((await call('/tagged', {})).headers.get('etag')).toBe('"abc"');
    expect((await call(`${MOUNT}/tagged`)).headers.get('etag')).toBeNull();
  });

  it('leaves JSON and error pages alone', async () => {
    expect(await (await call(`${MOUNT}/data`)).json()).toEqual({ url: '/api/v1/images/a.jpg' });
    expect(await (await call(`${MOUNT}/gone`)).text()).toBe('<a href="/p/x">x</a>');
  });
});

// The real Worker, mounted. The test bindings come from vitest.config.ts; the mount is added here.
describe('the Worker under /spotted-london', () => {
  it('is configured to run first for everything under the mount, or the static files would answer in its place', async () => {
    const { default: wranglerText } = await import('../wrangler.jsonc?raw');
    expect(wranglerText).toContain(`"${MOUNT}"`);
    expect(wranglerText).toContain(`"${MOUNT}/*"`);
  });

  const mountedEnv = Object.create(env, {
    BASE_PATH: { value: MOUNT },
    APP_URL: { value: `https://app.test${MOUNT}` },
    ENVIRONMENT: { value: 'production' },
  }) as typeof env;
  const get = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://app.test${path}`, { redirect: 'manual', ...init }) as never, mountedEnv, ctx);

  it('answers the API under the prefix', async () => {
    const res = await get(`${MOUNT}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('points robots.txt, the sitemap and the AI guide at the prefixed address', async () => {
    expect(await (await get(`${MOUNT}/robots.txt`)).text()).toContain(`Sitemap: https://app.test${MOUNT}/sitemap.xml`);
    expect(await (await get(`${MOUNT}/sitemap.xml`)).text()).toContain(`<loc>https://app.test${MOUNT}/connect</loc>`);
    const llms = await (await get(`${MOUNT}/llms.txt`)).text();
    expect(llms).toContain(`https://app.test${MOUNT}/mcp`);
    expect(llms).not.toContain('https://app.test/mcp');
  });

  it('serves the app shell for a page route, prefixed, and the static files without a database lookup', async () => {
    const page = await get(`${MOUNT}/add`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain(`<meta name="app-base" content="${MOUNT}">`);
    expect(text).toMatch(new RegExp(`src="${MOUNT}/assets/index-[^"]+\\.js"`));
    expect(text).not.toMatch(/src="\/assets\//);
    const manifest = await get(`${MOUNT}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toMatch(/json/);
  });

  it('keeps an unknown API path a JSON 404 instead of the app shell', async () => {
    const res = await get(`${MOUNT}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('signs in with the prefix in the link, the cookie path and the redirect', async () => {
    const addr = `mount_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const devEnv = Object.create(mountedEnv, { ENVIRONMENT: { value: 'development' } }) as typeof env;
    const send = (path: string, init: RequestInit) =>
      worker.fetch(new Request(`https://app.test${path}`, { redirect: 'manual', ...init }) as never, devEnv, ctx);

    const req = await send(`${MOUNT}/api/v1/auth/magic-link`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: addr, return_to: '/saved' }),
    });
    const link = ((await req.json()) as { dev_link: string }).dev_link;
    expect(link.startsWith(`https://app.test${MOUNT}/login/verify?token=`)).toBe(true);

    const token = new URL(link).searchParams.get('token')!;
    const done = await send(`${MOUNT}/login/verify`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      body: new URLSearchParams({ token, return_to: '/saved' }).toString(),
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${MOUNT}/saved`);
    const cookie = done.headers.getSetCookie().find(c => c.startsWith('sid='))!;
    expect(cookie).toMatch(new RegExp(`Path=${MOUNT}(;|$)`));
    expect(cookie).toMatch(/Secure/i);
  });
});
