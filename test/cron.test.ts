import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { recomputeHot, runCron } from '../src/cron';
import { hot } from '../src/lib/scoring';

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 13);

async function addPopup(id: string, o: { status?: string; startAt: number; endAt: number; hot?: number }) {
  await env.DB.prepare(`INSERT INTO popups (id, slug, title, category, start_at, end_at, lat, lng, geohash, address, status, created_by, created_at, updated_at, hot, is_example)
    VALUES (?, ?, ?, 'other', ?, ?, 51.5, -0.1, 'gcpvj', 'A', ?, 'cron_user', ?, ?, ?, 0)`)
    .bind(id, id, id, o.startAt, o.endAt, o.status ?? 'community', NOW, NOW, o.hot ?? 0).run();
}

const hotOf = async (id: string) => (await env.DB.prepare('SELECT hot FROM popups WHERE id = ?').bind(id).first<{ hot: number }>())!.hot;
const expected = (startAt: number, endAt: number, now: number, status: 'community' | 'verified_community' | 'verified_admin' = 'community') =>
  hot({ status, qualityPos: 0, qualityNeg: 0, startAt, endAt }, now);

describe('recomputeHot', () => {
  beforeAll(async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('cron_user', 'cron_user@test.dev', ?)").bind(NOW).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM popups WHERE created_by = 'cron_user'").run();
  });

  it('writes only the rows whose hot moved by 0.01 or more, so a second pass writes nothing', async () => {
    await addPopup('hot_stale', { startAt: NOW + DAY, endAt: NOW + 2 * DAY, hot: 0 });
    await addPopup('hot_live', { startAt: NOW - HOUR, endAt: NOW + HOUR, hot: 0 });

    expect(await recomputeHot(env.DB, NOW)).toBe(2);
    expect(await hotOf('hot_stale')).toBe(expected(NOW + DAY, NOW + 2 * DAY, NOW));
    expect(await hotOf('hot_live')).toBe(1.5);

    expect(await recomputeHot(env.DB, NOW)).toBe(0);
  });

  it('leaves a row alone when hot drifts by less than 0.01 and updates it past that', async () => {
    const start = NOW + 3 * DAY, end = NOW + 4 * DAY;
    await addPopup('hot_drift', { startAt: start, endAt: end, hot: expected(start, end, NOW) });
    const before = await hotOf('hot_drift');

    // 10 minutes later an upcoming pop-up decays by about 0.0035, which is not worth a write
    expect(await recomputeHot(env.DB, NOW + 10 * 60_000)).toBe(0);
    expect(await hotOf('hot_drift')).toBe(before);

    // 6 hours later it has decayed by about 0.125, so the row is rewritten
    expect(await recomputeHot(env.DB, NOW + 6 * HOUR)).toBe(1);
    expect(await hotOf('hot_drift')).toBe(expected(start, end, NOW + 6 * HOUR));
  });

  it('skips pop-ups that are over or not public', async () => {
    await addPopup('hot_over', { startAt: NOW - 2 * DAY, endAt: NOW - DAY, hot: 7 });
    await addPopup('hot_pending', { status: 'pending', startAt: NOW - HOUR, endAt: NOW + HOUR, hot: 7 });
    await recomputeHot(env.DB, NOW);
    expect(await hotOf('hot_over')).toBe(7);
    expect(await hotOf('hot_pending')).toBe(7);
  });

  it('runs on the hourly cron, not the ten-minute one', async () => {
    await addPopup('hot_cron', { startAt: NOW - HOUR, endAt: NOW + HOUR, hot: 0 });

    await runCron('*/10 * * * *', env, NOW);
    expect(await hotOf('hot_cron')).toBe(0);

    await runCron('0 * * * *', env, NOW);
    expect(await hotOf('hot_cron')).toBe(1.5);
  });
});
