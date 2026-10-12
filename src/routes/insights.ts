import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAdmin } from '../middleware';
import { INSIGHT_DAYS, insights as load, type InsightDays } from '../db/insights';

/** The Insights page. Admins only: it shows how people use the site, as counts and never as people. */
export const insights = new Hono<AppEnv>();

insights.get('/', async c => {
  requireAdmin(c);
  const asked = Number(c.req.query('days'));
  const days = (INSIGHT_DAYS as readonly number[]).includes(asked) ? (asked as InsightDays) : 7;
  return c.json(await load(c.env, days, c.get('now'), c.req.query('fresh') === '1'));
});
