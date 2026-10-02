// The public pop-up list as one row in D1 (table `snapshots`, key 'popups'), so a reader costs one row read
// however many pop-ups there are. Built by cron every 10 minutes and straight away when a pop-up enters or
// leaves the public set. The browser filters it with src/shared/filter-popups.ts.

import type { Context } from 'hono';
import type { AppEnv, PopupRow } from '../types';
import { DAY, hot, PUBLIC_STATUSES, type Status } from '../lib/scoring';
import { sha256 } from '../lib/util';
import { toPublic } from './popups';

/** D1 allows about 2 MB in a row. Past this the snapshot is not stored and readers get a fresh build. */
export const MAX_SNAPSHOT_BYTES = 1_500_000;
/** Pop-ups may be added up to this far ahead (MAX_DURATION), so nothing public starts later than this. */
const HORIZON = 90 * DAY;

/**
 * Every public pop-up that has not ended, as the list shows it: no `me`, no poster, no photos, no description.
 * `hot` is worked out here from the current time, so it does not depend on the stored column.
 */
export async function loadSnapshotItems(db: D1Database, now: number) {
  const { results } = await db.prepare(
    `SELECT *, (SELECT r2_key FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key
     FROM popups WHERE status IN (${PUBLIC_STATUSES.map(() => '?').join(',')}) AND end_at > ? AND start_at < ? ORDER BY id`,
  ).bind(...PUBLIC_STATUSES, now, now + HORIZON).all<PopupRow & { cover_key: string | null }>();
  return results.map(p => ({
    ...toPublic(p),
    description: null as string | null,
    hot: hot({ status: p.status, qualityPos: p.quality_pos, qualityNeg: p.quality_neg, startAt: p.start_at, endAt: p.end_at }, now),
  }));
}

export interface BuiltSnapshot { written: boolean; count: number; bytes: number; json: string; version: string }

/** Builds the snapshot and stores it. Too big to store: logs it, keeps the old row and still returns the build. */
export async function buildPopupSnapshot(db: D1Database, now: number, maxBytes = MAX_SNAPSHOT_BYTES): Promise<BuiltSnapshot> {
  const items = await loadSnapshotItems(db, now);
  const json = JSON.stringify({ items });
  const bytes = new TextEncoder().encode(json).length;
  const version = (await sha256(json)).slice(0, 16);
  if (bytes > maxBytes) {
    console.error(`popup snapshot is ${bytes} bytes (limit ${maxBytes}) with ${items.length} pop-ups: not stored. Split it by window or borough.`);
    return { written: false, count: items.length, bytes, json, version };
  }
  await db.prepare(
    `INSERT INTO snapshots (key, version, json, built_at) VALUES ('popups', ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET version = excluded.version, json = excluded.json, built_at = excluded.built_at`,
  ).bind(version, json, now).run();
  return { written: true, count: items.length, bytes, json, version };
}

const isPublic = (s: Status) => PUBLIC_STATUSES.includes(s);

/** True when a status change moves a pop-up into or out of the public list. */
export const entersOrLeavesPublic = (change: { from: Status; to: Status } | null | undefined) => !!change && isPublic(change.from) !== isPublic(change.to);

/** Rebuilds after the response has gone out, so the request that caused it does not wait. */
export function rebuildSnapshotSoon(c: Pick<Context<AppEnv>, 'env' | 'get' | 'executionCtx'>) {
  const run = buildPopupSnapshot(c.env.DB, c.get('now')).catch(e => console.error('snapshot rebuild failed', e));
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try { ctx = c.executionCtx; } catch { /* no execution context (some tests): the build still runs */ }
  ctx?.waitUntil(run);
}
