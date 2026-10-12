import { describe, expect, it } from 'vitest';
import manifestText from '../web/public/manifest.webmanifest?raw';
import sw from '../web/public/sw.js?raw';
import html from '../web/index.html?raw';
import wrangler from '../wrangler.jsonc?raw';

const manifest = JSON.parse(manifestText) as {
  name: string; short_name: string; start_url: string; scope: string; display: string;
  icons: { src: string; sizes: string; purpose: string }[]; shortcuts: { url: string }[];
};

describe('web app manifest', () => {
  it('opens the app full screen from the root', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it('has a 192 and a 512 icon, plain and maskable', () => {
    for (const purpose of ['any', 'maskable']) {
      for (const sizes of ['192x192', '512x512']) {
        expect(manifest.icons.some(i => i.purpose === purpose && i.sizes === sizes && i.src.startsWith('/icons/'))).toBe(true);
      }
    }
  });

  it('keeps shortcuts inside the app', () => {
    expect(manifest.shortcuts.map(s => s.url)).toEqual(['/add', '/saved']);
  });

  it('is linked from the page, with the iOS tags', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
  });
});

describe('service worker', () => {
  it('leaves every path the Worker owns alone, so data is never served from a cache', () => {
    const list = /const WORKER_PATHS = \[([^\]]*)\]/.exec(sw)?.[1] ?? '';
    // the Worker runs first for these (wrangler.jsonc assets.run_worker_first), and the page must not cache them
    for (const p of ['/api', '/login', '/mcp', '/privacy', '/llms.txt', '/sitemap.xml', '/robots.txt']) {
      expect(list).toContain(`'${p}'`);
      expect(wrangler).toContain(p === '/api' || p === '/login' ? `"${p}/*"` : `"${p}"`);
    }
  });

  it('only saves GET requests, and never an old file that came back as a page', () => {
    expect(sw).toContain("request.method !== 'GET'");
    expect(sw).toContain("includes('text/html')");
  });
});
