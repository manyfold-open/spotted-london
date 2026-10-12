import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { robotsText, sitemapXml } from '../src/pages';

describe('robots.txt and sitemap.xml', () => {
  it('lets crawlers in, keeps the API closed except photos, and points at the sitemap', () => {
    const t = robotsText('https://spotted.test');
    expect(t).toContain('User-agent: *');
    expect(t).toContain('Allow: /api/v1/images/');
    expect(t).toContain('Disallow: /api/');
    expect(t).toContain('Sitemap: https://spotted.test/sitemap.xml');
  });

  it('lists the home page, the guide pages and every pop-up, escaped', () => {
    const xml = sitemapXml('https://spotted.test', ['denim-night', 'a&b']);
    expect(xml).toContain('<loc>https://spotted.test/</loc>');
    expect(xml).toContain('<loc>https://spotted.test/p/denim-night</loc>');
    expect(xml).toContain('<loc>https://spotted.test/p/a%26b</loc>');
    expect(xml).not.toContain('a&b');
  });

  it('is served by the Worker with the right types', async () => {
    const robots = await exports.default.fetch(new Request('http://spotted.test/robots.txt'));
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toMatch(/text\/plain/);
    const map = await exports.default.fetch(new Request('http://spotted.test/sitemap.xml'));
    expect(map.status).toBe(200);
    expect(map.headers.get('content-type')).toMatch(/application\/xml/);
    expect(await map.text()).toContain('<urlset');
  });
});
