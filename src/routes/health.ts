import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAdmin } from '../middleware';
import { ApiError, newId } from '../lib/util';
import { jsonBody, oneOf } from '../lib/validate';
import { safeErrorText } from '../lib/a2a';
import { ASK_TEST_QUESTION, AUTOFILL_SAMPLE, TEST_GAP_MS } from '../lib/health';
import { HEALTH_FEATURES, type HealthFeature, type TestResult } from '../shared/health';
import { advanceAsk, answerOf, availableAgent, createAsk, loadAsk, startAsk } from '../db/ask';
import { ADMIN_TEST_WHO, lastTests, loadHealth, saveTest } from '../db/health';
import { extractFromText } from './extract';

/**
 * The Health panel on /admin/insights: how Ask and autofill have been doing, and a button that tries each one now.
 * Admins only. Not agent management, so AGENT_ADMIN_TOKEN does not open it.
 */
export const health = new Hono<AppEnv>();

health.get('/', async c => {
  requireAdmin(c);
  return c.json({ health: await loadHealth(c.env.DB, c.get('now')) });
});

/** One try a minute for each feature, counted from when the last one started. */
async function assertNotTooSoon(db: D1Database, feature: HealthFeature, now: number) {
  const last = (await lastTests(db))[feature];
  if (last && now >= last.at && now - last.at < TEST_GAP_MS) {
    throw new ApiError(429, 'test_too_soon', `The last ${feature === 'ask' ? 'Ask' : 'autofill'} test started less than a minute ago. Wait a little and try again.`);
  }
}

health.post('/test', async c => {
  requireAdmin(c);
  const now = c.get('now');
  const feature = oneOf(await jsonBody(c.req), 'feature', HEALTH_FEATURES, { required: true })!;
  await assertNotTooSoon(c.env.DB, feature, now);

  if (feature === 'autofill') {
    const started = Date.now();
    let result: TestResult;
    try {
      const e = await extractFromText(c.env, AUTOFILL_SAMPLE, now);
      const ok = !!e.title && !!e.start_date;
      result = { feature, ok, ms: Date.now() - started, at: now, detail: ok ? `Found "${e.title}" starting ${e.start_date}.` : 'The model answered, but found no name or start date in a text that has both.' };
    } catch (err) {
      result = { feature, ok: false, ms: Date.now() - started, at: now, detail: err instanceof ApiError ? err.message : safeErrorText(err) };
    }
    await saveTest(c.env.DB, result, now);
    return c.json({ result });
  }

  const agent = await availableAgent(c.env.DB);
  if (!agent) {
    const result: TestResult = { feature, ok: false, ms: null, at: now, detail: 'No Concierge is connected and switched on, so visitors cannot use Ask either. Open /admin/agent.' };
    await saveTest(c.env.DB, result, now);
    return c.json({ result });
  }
  const ask = await startAsk(c.env, agent, await createAsk(c.env.DB, { id: newId(), who: ADMIN_TEST_WHO, text: ASK_TEST_QUESTION, taste: null, nearMe: false, agentId: agent.id, now }), null, now);
  const pending: TestResult = { feature, ok: null, ms: null, at: now, id: ask.id, detail: 'Waiting for the Concierge...' };
  await saveTest(c.env.DB, pending, now);
  return c.json({ result: pending, id: ask.id });
});

/** The page polls this while an Ask test is waiting. It moves the question on the way a visitor's poll does. */
health.get('/test/ask/:id', async c => {
  requireAdmin(c);
  const now = c.get('now');
  const id = c.req.param('id');
  const stored = await loadAsk(c.env.DB, id);
  if (!stored || stored.ip_hash !== ADMIN_TEST_WHO) throw new ApiError(404, 'not_found', 'That test is gone.');
  const ask = await advanceAsk(c.env, stored, now);
  const current = (await lastTests(c.env.DB)).ask;
  if (ask.status === 'pending' || current?.id !== id || current.ok !== null) return c.json({ result: current?.id === id ? current : null, status: ask.status });

  const picks = answerOf(ask)?.picks.length ?? 0;
  const ok = ask.status === 'done' && picks > 0;
  const result: TestResult = {
    feature: 'ask', ok, id, at: current.at, ms: (ask.finished_at ?? now) - ask.asked_at,
    detail: ok ? `The Concierge picked ${picks} pop-up${picks === 1 ? '' : 's'}.`
      : ask.status === 'done' ? 'The Concierge answered, but picked nothing from the public list.' : (ask.error ?? 'The Concierge did not answer.'),
  };
  await saveTest(c.env.DB, result, now);
  return c.json({ result, status: ask.status });
});
