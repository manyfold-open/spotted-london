import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { headTags, robotsText, sitemapXml } from '../src/pages';
import type { PopupRow } from '../src/types';

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

describe('pop-ups with several date ranges in link previews', () => {
  const day = (m: number, d: number, h = 0) => Date.UTC(2026, m - 1, d, h);
  const base = { slug: 'bank-tours', title: 'Bank tours', description: 'Tours', address: 'Threadneedle Street', borough: 'City', lat: 51.5, lng: -0.09, host: null, price_type: 'paid', date_kind: null, is_example: 0 };

  it('is one event series with an event for each range, not one long event', () => {
    const ranges = [[day(10, 29), day(10, 29, 23)], [day(11, 26), day(11, 26, 23)]];
    const html = headTags({ ...base, start_at: ranges[0][0], end_at: ranges[1][1], date_ranges: JSON.stringify(ranges) } as unknown as PopupRow, 'https://spotted.test');
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]);
    expect(ld['@type']).toBe('EventSeries');
    expect(ld.subEvent.map((e: { startDate: string }) => e.startDate)).toEqual(ranges.map(r => new Date(r[0]).toISOString()));
    expect(html).toContain('On 29 Oct, 26 Nov in City.');
  });

  it('an ordinary pop-up is still one Event', () => {
    const html = headTags({ ...base, start_at: day(10, 29), end_at: day(10, 30), date_ranges: null } as unknown as PopupRow, 'https://spotted.test');
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]);
    expect(ld['@type']).toBe('Event');
    expect(ld.subEvent).toBeUndefined();
  });
});
