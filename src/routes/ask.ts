import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ipHash, verifyTurnstile } from '../middleware';
import { ApiError, newId } from '../lib/util';
import { jsonBody } from '../lib/validate';
import { ASK_MAX_CHARS, cleanQuestion, readTaste } from '../lib/ask';
import { snapshotItems } from '../db/snapshot';
import { ASK_RESTING, askLimited } from '../shared/ask-messages';
import { advanceAsk, answerOf, ASK_PER_VISITOR, availableAgent, createAsk, dailyCap, loadAsk, startAsk, usage, type AskRow } from '../db/ask';

// Ask for recommendations. Anyone can ask, signed in or not, so the limits are per visitor (a salted hash of the IP)
// and for all visitors together. Hitting one never breaks the page: the answer is an error with a message to show.

export const ask = new Hono<AppEnv>();

const RESTING = ASK_RESTING;
const LIMITED = askLimited(ASK_PER_VISITOR);
const FAILED = 'Ask could not answer this time. The filters and For you still work. Try again in a minute.';
const NOTHING = 'Nothing on Spotted matches that right now. Try the filters, or ask in other words.';

/** What the page needs: the answer as pop-ups still in the public list, or why there is none. */
async function view(c: { env: AppEnv['Bindings'] }, a: AskRow, now: number, left?: number) {
  const base = { id: a.id, status: a.status, ...(left !== undefined ? { left } : {}) };
  if (a.status === 'pending') return { ...base, elapsed_ms: Math.max(0, now - a.asked_at), poll_ms: 2000 };
  if (a.status === 'failed') return { ...base, message: FAILED };
  const answer = answerOf(a);
  const items = await snapshotItems(c.env.DB, now);
  const byId = new Map(items.filter(p => p.end_at > now).map(p => [p.id, p]));
  const picks = (answer?.picks ?? []).flatMap(p => {
    const item = byId.get(p.id);
    return item ? [{ id: item.id, slug: item.slug, title: item.title, reason: p.reason }] : [];
  });
  // `near`: the agent judged the request to be about the visitor's position, and the browser can order by distance
  return { ...base, picks, note: picks.length ? (answer?.note ?? '') : (answer?.note || NOTHING), near: !!a.near_me && !!answer?.near };
}

/** Whether to show Ask at all, and what is left today. Before an agent is connected (or migration 0018), it is simply off. */
ask.get('/status', async c => {
  c.header('cache-control', 'no-store');
  const now = c.get('now');
  try {
    const [agent, u] = await Promise.all([availableAgent(c.env.DB), usage(c.env.DB, (await ipHash(c)) ?? 'none', now)]);
    const resting = u.total >= dailyCap(c.env);
    return c.json({
      available: !!agent, resting, per_visitor: ASK_PER_VISITOR, left: Math.max(0, ASK_PER_VISITOR - u.visitor), max_chars: ASK_MAX_CHARS,
      needs_bot_check: u.visitor === 0, turnstile_site_key: c.env.TURNSTILE_SECRET ? (c.env.TURNSTILE_SITE_KEY ?? null) : null,
    });
  } catch (e) {
    console.warn('ask status unavailable', e);
    return c.json({ available: false, resting: false, per_visitor: ASK_PER_VISITOR, left: 0, max_chars: ASK_MAX_CHARS, needs_bot_check: false, turnstile_site_key: null });
  }
});

ask.post('/', async c => {
  c.header('cache-control', 'no-store');
  const now = c.get('now');
  const db = c.env.DB;
  const b = await jsonBody(c.req);
  const text = cleanQuestion(b.text);
  const taste = readTaste(b.taste);
  const who = (await ipHash(c)) ?? 'none';

  const [agent, u] = await Promise.all([availableAgent(db), usage(db, who, now)]);
  if (!agent || u.total >= dailyCap(c.env)) throw new ApiError(503, 'ask_resting', RESTING);
  if (u.visitor >= ASK_PER_VISITOR) throw new ApiError(429, 'ask_limit', LIMITED);
  // The first question of the day proves the visitor is a person. After that the same page carries on.
  if (u.visitor === 0) await verifyTurnstile(c, typeof b.turnstile_token === 'string' ? b.turnstile_token : undefined);

  const row = await createAsk(db, { id: newId(), who, text, taste, nearMe: b.near_me === true, agentId: agent.id, now });
  const started = await startAsk(c.env, agent, row, taste, now);
  return c.json(await view(c, started, now, Math.max(0, ASK_PER_VISITOR - u.visitor - 1)), 201);
});

/** The page polls this every couple of seconds. The id is random and the answer holds only public pop-ups. */
ask.get('/:id', async c => {
  c.header('cache-control', 'no-store');
  const now = c.get('now');
  const id = c.req.param('id');
  const row = /^[0-9a-f]{16}$/.test(id) ? await loadAsk(c.env.DB, id) : null;
  if (!row) throw new ApiError(404, 'not_found', 'That question is gone. Ask again.');
  return c.json(await view(c, await advanceAsk(c.env, row, now), now));
});
