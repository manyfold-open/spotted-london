import { afterEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { cleanBatch, toDataPoint } from '../src/lib/events';

const good = { v: 'abcDEF123456', s: 1, w: 'm', events: [{ e: 'view', r: 'home', x: 1, f: 'google.com' }] };

describe('cleanBatch', () => {
  it('accepts a batch and keeps only fixed fields', () => {
    const b = cleanBatch(good)!;
    expect(b).toMatchObject({ vid: 'abcDEF123456', signedIn: 1, device: 'm' });
    expect(b.events).toEqual([{ name: 'view', route: 'home', slug: '', detail: '', ref: 'google.com', x: 1 }]);
  });

  it('drops unknown events, bad ids and anything that is not a fixed word', () => {
    expect(cleanBatch({ ...good, v: 'short' })).toBeNull();
    expect(cleanBatch({ ...good, v: 'has spaces and an @ sign' })).toBeNull();
    expect(cleanBatch({ ...good, events: [{ e: 'keylog' }] })).toBeNull();
    expect(cleanBatch('nope')).toBeNull();
    expect(cleanBatch(null)).toBeNull();
    const b = cleanBatch({ ...good, events: [
      { e: 'save', p: 'Denim Night', d: 'a typed sentence with spaces', r: '/admin?x=1' },
      { e: 'save', p: 'denim-night', d: 'food', x: 99_999_999 },
    ] })!;
    expect(b.events[0]!).toMatchObject({ slug: '', detail: '', route: '' }); // free text and paths never get through
    expect(b.events[1]!).toMatchObject({ slug: 'denim-night', detail: 'food', x: 1e6 });
  });

  it('takes at most 10 events', () => {
    const many = Array.from({ length: 25 }, () => ({ e: 'view' }));
    expect(cleanBatch({ ...good, events: many })!.events).toHaveLength(10);
  });

  it('builds the data point in the column order the Insights page reads', () => {
    const b = cleanBatch({ ...good, events: [{ e: 'popup_open', p: 'denim-night', d: 'fashion' }] })!;
    expect(toDataPoint(b, b.events[0]!, 'GB')).toEqual({
      indexes: ['abcDEF123456'],
      blobs: ['popup_open', '', 'denim-night', 'fashion', '', 'm', 'GB'],
      doubles: [1, 0],
    });
    expect(toDataPoint(b, b.events[0]!, 'not a country').blobs![6]).toBe('');
  });
});

describe('POST /api/v1/e', () => {
  const points: AnalyticsEngineDataPoint[] = [];
  const stub = { writeDataPoint: (p: AnalyticsEngineDataPoint) => { points.push(p); } } as AnalyticsEngineDataset;
  const send = (body: unknown, headers: Record<string, string> = {}) => exports.default.fetch(new Request('http://spotted.test/api/v1/e', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const withDataset = () => Object.defineProperty(env, 'EVENTS', { configurable: true, writable: true, value: stub });
  afterEach(() => { points.length = 0; Object.defineProperty(env, 'EVENTS', { configurable: true, writable: true, value: undefined }); });

  it('writes one data point per event and answers 204 with no body', async () => {
    withDataset();
    const res = await send({ ...good, events: [{ e: 'view', r: 'home' }, { e: 'save', p: 'denim-night', d: 'fashion', x: 1 }] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(points).toHaveLength(2);
    expect(points[1]!.blobs![0]).toBe('save');
  });

  it('answers 204 and writes nothing for bad input, so a caller learns nothing', async () => {
    withDataset();
    expect((await send('{not json')).status).toBe(204);
    expect((await send({ v: 'abcDEF123456', events: [{ e: 'nope' }] })).status).toBe(204);
    expect((await send('x'.repeat(5000))).status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it('does nothing, and does not break, when the dataset is not bound', async () => {
    expect((await send(good)).status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it('does not look up the session, so an event never costs a database read', async () => {
    withDataset();
    const res = await send(good, { cookie: 'sid=whatever' });
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
  });
});
