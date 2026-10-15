import { describe, expect, it } from 'vitest';
import { analyticsMeta, consentRequiredFor, measuredId, measurementIdFor, withAnalytics } from '../src/analytics';

const PROD = { ENVIRONMENT: 'production', APP_URL: 'https://app.manyfold.ai/spotted-london', GA_MEASUREMENT_ID: 'G-P9WVSTMG87' };
const page = () => new Response('<html><head><title>Spotted London</title></head><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
const visit = (url: string, country?: string) => new Request(url, country ? { cf: { country } } : {});

describe('Google Analytics on pages', () => {
  it('measures only with a GA4 measurement id', () => {
    expect(measurementIdFor({ GA_MEASUREMENT_ID: ' g-p9wvstmg87 ' })).toBe('G-P9WVSTMG87');
    expect(measurementIdFor({})).toBeNull();
    expect(measurementIdFor({ GA_MEASUREMENT_ID: 'UA-1234-1' })).toBeNull();
    expect(measurementIdFor({ GA_MEASUREMENT_ID: 'G-X"><script>' })).toBeNull();
  });

  it('asks visitors in the UK, the EEA and Switzerland first, and any visitor whose country is unknown', () => {
    for (const c of ['GB', 'FR', 'IE', 'NO', 'CH']) expect(consentRequiredFor(c), c).toBe(true);
    for (const c of [undefined, null, '', 'XX', 'T1', 'gb']) expect(consentRequiredFor(c), String(c)).toBe(true);
    for (const c of ['US', 'TW', 'HK']) expect(consentRequiredFor(c), c).toBe(false);
  });

  it('measures production pages on the public host only: not previews, workers.dev or local dev', () => {
    expect(measuredId(visit('https://app.manyfold.ai/spotted-london/'), PROD)).toBe('G-P9WVSTMG87');
    expect(measuredId(visit('https://abc123-manyfold-spotted-london.netmind.workers.dev/'), PROD)).toBeNull();
    expect(measuredId(visit('https://app.manyfold.ai/spotted-london/'), { ...PROD, ENVIRONMENT: 'development' })).toBeNull();
    expect(measuredId(visit('https://app.manyfold.ai/spotted-london/'), { ...PROD, GA_MEASUREMENT_ID: '' })).toBeNull();
  });

  it('writes the property and whether to ask into the head of a measured page', async () => {
    const uk = await withAnalytics(page(), visit('https://app.manyfold.ai/spotted-london/', 'GB'), PROD).text();
    expect(uk).toContain(`${analyticsMeta('G-P9WVSTMG87', true)}</head>`);
    const us = await withAnalytics(page(), visit('https://app.manyfold.ai/spotted-london/p/x', 'US'), PROD).text();
    expect(us).toContain('<meta name="spotted-analytics" content="G-P9WVSTMG87" data-ask="0">');
  });

  it('leaves unmeasured pages, errors and anything that is not HTML alone', () => {
    const preview = page();
    expect(withAnalytics(preview, visit('https://x.workers.dev/'), PROD)).toBe(preview);
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(withAnalytics(json, visit('https://app.manyfold.ai/spotted-london/api/v1/health'), PROD)).toBe(json);
    const missing = new Response('<html><head></head></html>', { status: 404, headers: { 'content-type': 'text/html' } });
    expect(withAnalytics(missing, visit('https://app.manyfold.ai/spotted-london/nope'), PROD)).toBe(missing);
  });
});
