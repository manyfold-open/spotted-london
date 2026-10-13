import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { judge, DAY_LIMITS, INCLUDED, MONTH_SHARE, STORAGE_LIMIT_GB, type Usage } from '../src/lib/usage';
import { guardOn, guardState, refreshGuard } from '../src/db/usage';
import { runCron } from '../src/cron';
import { addPhotoFromUrl } from '../src/lib/photo';
import type { Bindings } from '../src/types';

const NOW = Date.UTC(2026, 9, 14, 12);
const calm: Usage = { day: { rowsRead: 3e6, rowsWritten: 2e5, classA: 300 }, month: { rowsRead: 4e7, rowsWritten: 2e6, classA: 4000 }, storageGb: 0.5 };

describe('the rule', () => {
  it('lets a normal day through', () => {
    expect(judge(calm)).toEqual({ on: false, reasons: [] });
  });

  it('stops on each limit, and names it', () => {
    const over = (patch: Partial<Usage['day']>, month: Partial<Usage['month']> = {}, storageGb = 0.5): Usage =>
      ({ day: { ...calm.day, ...patch }, month: { ...calm.month, ...month }, storageGb });
    expect(judge(over({ rowsWritten: DAY_LIMITS.rowsWritten })).reasons[0]).toMatch(/D1 rows written today/);
    expect(judge(over({ rowsRead: DAY_LIMITS.rowsRead })).reasons[0]).toMatch(/D1 rows read today/);
    expect(judge(over({ classA: DAY_LIMITS.classA })).reasons[0]).toMatch(/R2 writes today/);
    expect(judge(over({}, { rowsWritten: INCLUDED.rowsWritten * MONTH_SHARE })).reasons[0]).toMatch(/rows written this month/);
    expect(judge(over({}, { rowsRead: INCLUDED.rowsRead * MONTH_SHARE })).reasons[0]).toMatch(/rows read this month/);
    expect(judge(over({}, { classA: INCLUDED.classA * MONTH_SHARE })).reasons[0]).toMatch(/R2 writes this month/);
    expect(judge(over({}, {}, STORAGE_LIMIT_GB)).reasons[0]).toMatch(/R2 storage/);
  });

  it('is well above what the site does on an ordinary day', () => {
    // 2 to 3 million rows read and about 100 to 300 thousand written a day, measured on the first deployment
    expect(DAY_LIMITS.rowsRead).toBeGreaterThan(100 * 3e6);
    expect(DAY_LIMITS.rowsWritten).toBeGreaterThanOrEqual(10 * 3e5);
  });
});

const configured = (patch: Partial<Bindings> = {}) =>
  Object.create(env, {
    CF_ACCOUNT_ID: { value: 'acct' }, CF_ANALYTICS_TOKEN: { value: 'token' }, USAGE_D1_ID: { value: 'db-id' }, USAGE_R2_BUCKET: { value: 'bucket' },
    ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { value: v }])),
  }) as Bindings;

/** What Cloudflare's GraphQL analytics answers: the day, then the month. */
function analytics(day: { read: number; written: number; ops: number; gb?: number }, month = { read: 1e7, written: 1e6, ops: 1000 }) {
  const answer = (v: { read: number; written: number; ops: number; gb?: number }) => ({
    d1: [{ sum: { rowsRead: v.read, rowsWritten: v.written } }],
    ops: [{ sum: { requests: v.ops }, dimensions: { actionType: 'PutObject' } }, { sum: { requests: 99_999_999 }, dimensions: { actionType: 'GetObject' } }],
    store: [{ max: { payloadSize: (v.gb ?? 0.4) * 1e9, metadataSize: 0 } }],
  });
  let n = 0;
  return vi.fn(async () => Response.json({ data: { viewer: { accounts: [answer(n++ % 2 === 0 ? day : { ...month, gb: day.gb })] } } }));
}

afterEach(async () => { await env.DB.prepare("DELETE FROM settings WHERE key = 'usage_guard'").run(); vi.restoreAllMocks(); });

describe('the hourly check', () => {
  it('does nothing, and says so, when it is not set up', async () => {
    const s = await refreshGuard(env, NOW);
    expect(s).toMatchObject({ configured: false, on: false });
    expect(await guardOn(env.DB)).toBe(false);
  });

  it('stays off on a calm day and does not count reads of R2 as writes', async () => {
    const fetcher = analytics({ read: 3e6, written: 2e5, ops: 300 });
    const s = await refreshGuard(configured(), NOW, fetcher as never);
    expect(s).toMatchObject({ configured: true, on: false, error: null });
    expect(s.usage!.day.classA).toBe(300); // the 99,999,999 GetObject calls are class B
    expect(s.usage!.storageGb).toBeCloseTo(0.4);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(String(calls[0]![1].body));
    expect(body.variables).toMatchObject({ a: 'acct', db: 'db-id', b: 'bucket', d1: '2026-10-14', d2: '2026-10-14' });
    expect(JSON.parse(String(calls[1]![1].body)).variables).toMatchObject({ d1: '2026-10-01', d2: '2026-10-14' });
  });

  it('goes on when a day runs far above normal, and lets go when the numbers fall back', async () => {
    const on = await refreshGuard(configured(), NOW, analytics({ read: 3e6, written: DAY_LIMITS.rowsWritten + 1, ops: 300 }) as never);
    expect(on.on).toBe(true);
    expect(on.reasons[0]).toMatch(/D1 rows written today/);
    expect(await guardOn(env.DB)).toBe(true);
    const off = await refreshGuard(configured(), NOW + 86_400_000, analytics({ read: 3e6, written: 2e5, ops: 300 }) as never);
    expect(off.on).toBe(false);
    expect(await guardOn(env.DB)).toBe(false);
  });

  it('keeps the last verdict when Cloudflare cannot be reached, and says why', async () => {
    await refreshGuard(configured(), NOW, analytics({ read: 3e6, written: DAY_LIMITS.rowsWritten + 1, ops: 300 }) as never);
    const s = await refreshGuard(configured(), NOW + 3_600_000, vi.fn(async () => new Response('no', { status: 500 })) as never);
    expect(s.on).toBe(true);
    expect(s.error).toMatch(/500/);
    expect((await guardState(env.DB)).error).toMatch(/500/);
  });

  it('stays off, and does not throw, when the answer is an error', async () => {
    const s = await refreshGuard(configured(), NOW, vi.fn(async () => Response.json({ errors: [{ message: 'not authorized' }] })) as never);
    expect(s).toMatchObject({ on: false, configured: true });
    expect(s.error).toMatch(/not authorized/);
  });
});

describe('what the guard holds back', () => {
  const turnOn = () => refreshGuard(configured(), NOW, analytics({ read: 3e6, written: DAY_LIMITS.rowsWritten + 1, ops: 300 }) as never);

  it('skips the agents, Apify posts and the photo backfill in the 10 minute job, but still ends expired pop-ups', async () => {
    await turnOn();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const id = `guard-${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare('INSERT INTO users (id, email, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, 0, 0, 1, ?)').bind(`u_${id}`, `${id}@test.dev`, 'user', NOW - 9e7).run();
    await env.DB.prepare(`INSERT INTO popups (id, slug, title, category, start_at, end_at, lat, lng, geohash, address, status, created_by, created_at, updated_at, hot, is_example)
      VALUES (?, ?, 'Guard test', 'other', ?, ?, 51.5, -0.1, 'gcpvj', 'A', 'community', ?, ?, ?, 0, 0)`).bind(id, id, NOW - 9e6, NOW - 1e6, `u_${id}`, NOW - 1e7, NOW - 1e7).run();
    await runCron('*/10 * * * *', env, NOW);
    expect((await env.DB.prepare('SELECT status FROM popups WHERE id = ?').bind(id).first<{ status: string }>())!.status).toBe('ended');
    expect(fetcher).not.toHaveBeenCalled(); // no agent, Apify or page fetch started
  });

  it('refuses a new photo upload and a thumbnail with a plain message', async () => {
    await turnOn();
    const u = `ug_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare('INSERT INTO users (id, email, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, 58, 3, 1, ?)').bind(u, `${u}@test.dev`, 'user', NOW - 9e7).run();
    const made = await exports.default.fetch(new Request('http://spotted.test/api/v1/popups', {
      method: 'POST', headers: { 'x-dev-user': u, 'content-type': 'application/json', 'x-now': String(NOW) },
      body: JSON.stringify({ title: `Guard stall ${u}`, category: 'market', lat: 51.55 + Math.random() / 50, lng: -0.07, start_at: NOW + 86_400_000, end_at: NOW + 2 * 86_400_000, source_url: 'https://example.com/x' }),
    }));
    const p = (await made.json()) as { id: string };
    const photo = await exports.default.fetch(new Request(`http://spotted.test/api/v1/popups/${p.id}/images`, {
      method: 'POST', headers: { 'x-dev-user': u, 'content-type': 'image/webp', 'x-now': String(NOW) }, body: new Uint8Array([1, 2, 3]),
    }));
    expect(photo.status).toBe(503);
    expect(((await photo.json()) as { error: { code: string } }).error.code).toBe('photos_paused');
    const thumb = await exports.default.fetch(new Request(`http://spotted.test/api/v1/popups/${p.id}/images/x/thumb`, {
      method: 'PUT', headers: { 'x-dev-user': u, 'content-type': 'image/webp', 'x-now': String(NOW) }, body: new Uint8Array([1, 2, 3]),
    }));
    expect(thumb.status).toBe(503);
  });

  it('makes the Scout and the paste-a-link copy skip the photo rather than fail the draft', async () => {
    await turnOn();
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const r = await addPhotoFromUrl({ DB: env.DB, IMAGES: bucket }, 'p1', 'dev_zack', { imageUrl: 'https://example.com/a.jpg', pageUrl: null }, NOW);
    expect(r).toMatchObject({ saved: false, reason: expect.stringMatching(/paused/) });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('shows the admin what it is doing', async () => {
    await turnOn();
    const res = await exports.default.fetch(new Request('http://spotted.test/api/v1/admin/agents', { headers: { authorization: 'Bearer test-agent-manager-token-at-least-32-chars' } }));
    const body = (await res.json()) as { usage_guard: { on: boolean; configured: boolean; reasons: string[] } };
    expect(body.usage_guard).toMatchObject({ on: true, configured: true });
    expect(body.usage_guard.reasons[0]).toMatch(/rows written/);
  });
});
