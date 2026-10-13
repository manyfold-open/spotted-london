// Spending guard (rule in src/lib/usage.ts). Once an hour the Worker asks Cloudflare's analytics how much D1 and R2 it
// has used today and this month. When the rule says stop, the background work that writes is skipped and new photos are
// refused until the numbers come down. It needs CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN (Account Analytics: Read, the same
// pair the Insights page uses), USAGE_D1_ID and USAGE_R2_BUCKET. Without them it does nothing, and the admin page says so.

import type { Bindings } from '../types';
import { ApiError } from '../lib/util';
import { judge, type Usage } from '../lib/usage';

const KEY = 'usage_guard';

export interface GuardState {
  /** True when the guard is set up: the account, the token, the database id and the bucket are all there. */
  configured: boolean;
  on: boolean;
  reasons: string[];
  checked_at: number | null;
  error: string | null;
  usage: Usage | null;
}

const EMPTY: GuardState = { configured: false, on: false, reasons: [], checked_at: null, error: null, usage: null };

export async function guardState(db: D1Database): Promise<GuardState> {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first<{ value: string }>();
    return row ? { ...EMPTY, ...(JSON.parse(row.value) as Partial<GuardState>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Background work that writes is skipped while the guard is on. Never throws: a broken check must not stop the site. */
export const guardOn = async (db: D1Database): Promise<boolean> => (await guardState(db)).on;

/** New photos are refused while it is on (R2 and D1 writes). */
export async function assertPhotosOpen(db: D1Database) {
  if (await guardOn(db)) throw new ApiError(503, 'photos_paused', 'Photo uploads are paused for a while because the site is close to its usage limits. Try again later; your pop-up does not need a photo.');
}

const QUERY = `query($a: String!, $d1: Date!, $d2: Date!, $db: String!, $b: String!) {
  viewer { accounts(filter: { accountTag: $a }) {
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: $d1, date_leq: $d2, databaseId: $db }) { sum { rowsRead rowsWritten } }
    ops: r2OperationsAdaptiveGroups(limit: 50, filter: { date_geq: $d1, date_leq: $d2, bucketName: $b }) { sum { requests } dimensions { actionType } }
    store: r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC], filter: { date_geq: $d1, date_leq: $d2, bucketName: $b }) { max { payloadSize metadataSize } dimensions { datetime } }
  } } }`;

interface Answer {
  d1: { sum: { rowsRead: number; rowsWritten: number } }[];
  ops: { sum: { requests: number }; dimensions: { actionType: string } }[];
  store: { max: { payloadSize: number; metadataSize: number } }[];
}

async function ask(env: Bindings, from: string, to: string, fetcher: typeof fetch): Promise<Answer> {
  const res = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { a: env.CF_ACCOUNT_ID, d1: from, d2: to, db: env.USAGE_D1_ID, b: env.USAGE_R2_BUCKET } }),
  });
  if (!res.ok) throw new Error(`analytics answered ${res.status}`);
  const body = (await res.json()) as { data?: { viewer: { accounts: Answer[] } }; errors?: { message: string }[] };
  if (body.errors?.length || !body.data?.viewer.accounts[0]) throw new Error(body.errors?.map(e => e.message).join('; ') || 'analytics returned nothing');
  return body.data.viewer.accounts[0];
}

// Only writes count as class A here (everything that is not a Get or Head).
const classA = (a: Answer) => a.ops.reduce((n, o) => n + (/^(Get|Head)/.test(o.dimensions.actionType) ? 0 : o.sum.requests), 0);

export async function readUsage(env: Bindings, now: number, fetcher: typeof fetch = fetch): Promise<Usage> {
  const today = new Date(now).toISOString().slice(0, 10);
  const first = `${today.slice(0, 8)}01`;
  const [day, month] = [await ask(env, today, today, fetcher), await ask(env, first, today, fetcher)];
  const store = month.store[0]?.max;
  return {
    day: { rowsRead: day.d1[0]?.sum.rowsRead ?? 0, rowsWritten: day.d1[0]?.sum.rowsWritten ?? 0, classA: classA(day) },
    month: { rowsRead: month.d1[0]?.sum.rowsRead ?? 0, rowsWritten: month.d1[0]?.sum.rowsWritten ?? 0, classA: classA(month) },
    storageGb: ((store?.payloadSize ?? 0) + (store?.metadataSize ?? 0)) / 1e9,
  };
}

const configured = (env: Bindings) => !!(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN && env.USAGE_D1_ID && env.USAGE_R2_BUCKET);

/** Hourly. One write to the settings table, whatever the answer. A failed check keeps the last verdict and says why. */
export async function refreshGuard(env: Bindings, now: number, fetcher: typeof fetch = fetch): Promise<GuardState> {
  const before = await guardState(env.DB);
  let next: GuardState;
  if (!configured(env)) {
    next = { ...EMPTY, checked_at: now };
  } else {
    try {
      const usage = await readUsage(env, now, fetcher);
      next = { configured: true, ...judge(usage), checked_at: now, error: null, usage };
      if (next.on && !before.on) console.warn('usage guard on:', next.reasons.join('; '));
    } catch (e) {
      next = { ...before, configured: true, checked_at: now, error: e instanceof Error ? e.message : 'the check failed' };
      console.warn('usage guard check failed:', next.error);
    }
  }
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(KEY, JSON.stringify(next), now).run();
  return next;
}
