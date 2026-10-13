// Spending guard: the numbers and the rule, with no I/O. src/db/usage.ts reads the numbers from Cloudflare.
//
// Cloudflare has no hard spending cap, so the Worker checks its own D1 and R2 use once an hour and, when it is
// running far above normal or close to what the plan includes, stops the background work that writes (agents, Apify
// posts, photo backfill) and new photo uploads. Reading the site keeps working. It lets go by itself when the
// numbers fall back (a new UTC day, a new month).

export interface Usage {
  /** UTC day so far, and the calendar month so far. */
  day: { rowsRead: number; rowsWritten: number; classA: number };
  month: { rowsRead: number; rowsWritten: number; classA: number };
  storageGb: number;
}

/** What the Workers Paid plan includes each month (developers.cloudflare.com/d1/platform/pricing, /r2/pricing). */
export const INCLUDED = { rowsRead: 25_000_000_000, rowsWritten: 50_000_000, classA: 1_000_000, storageGb: 10 };

/** Share of a month's allowance at which the brake goes on. */
export const MONTH_SHARE = 0.8;

/**
 * Per UTC day. Normal is a few million rows read, a few hundred thousand written and a few hundred R2 writes, so
 * these are tens of times that and still a small part of the month (rows written: 3 million a day for ten days
 * is 60% of the allowance).
 */
export const DAY_LIMITS = { rowsRead: 500_000_000, rowsWritten: 3_000_000, classA: 100_000 };

/** Photos are the one thing that grows R2 storage. */
export const STORAGE_LIMIT_GB = 8;

export interface Verdict { on: boolean; reasons: string[] }

const m = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n.toLocaleString('en-GB'));

export function judge(u: Usage): Verdict {
  const reasons: string[] = [];
  const check = (label: string, value: number, limit: number, where: string) => {
    if (value >= limit) reasons.push(`${label} ${where}: ${m(value)} (limit ${m(limit)})`);
  };
  check('D1 rows read', u.day.rowsRead, DAY_LIMITS.rowsRead, 'today');
  check('D1 rows written', u.day.rowsWritten, DAY_LIMITS.rowsWritten, 'today');
  check('R2 writes', u.day.classA, DAY_LIMITS.classA, 'today');
  check('D1 rows read', u.month.rowsRead, INCLUDED.rowsRead * MONTH_SHARE, 'this month');
  check('D1 rows written', u.month.rowsWritten, INCLUDED.rowsWritten * MONTH_SHARE, 'this month');
  check('R2 writes', u.month.classA, INCLUDED.classA * MONTH_SHARE, 'this month');
  if (u.storageGb >= STORAGE_LIMIT_GB) reasons.push(`R2 storage: ${u.storageGb.toFixed(1)} GB (limit ${STORAGE_LIMIT_GB} GB)`);
  return { on: reasons.length > 0, reasons };
}
