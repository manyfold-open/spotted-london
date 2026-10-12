import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { withinPublicLimit } from '../middleware';
import { cleanBatch, toDataPoint } from '../lib/events';

/**
 * Anonymous usage events from the browser (see web/src/lib/track.ts and the privacy page).
 * No session lookup, no D1 or KV write: a data point goes to Workers Analytics Engine and the answer is always 204,
 * so a bad or limited request tells a caller nothing and the page never shows an error for it.
 */
export const events = new Hono<AppEnv>();

const MAX_BODY = 4096;

events.post('/', async c => {
  const ds = c.env.EVENTS;
  if (!ds || !(await withinPublicLimit(c, 'event'))) return c.body(null, 204);
  const text = await c.req.text();
  if (text.length > MAX_BODY) return c.body(null, 204);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return c.body(null, 204); }
  const batch = cleanBatch(body);
  if (!batch) return c.body(null, 204);
  const country = (c.req.raw as Request & { cf?: { country?: string } }).cf?.country ?? '';
  for (const e of batch.events) ds.writeDataPoint(toDataPoint(batch, e, country));
  return c.body(null, 204);
});
