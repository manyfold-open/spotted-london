import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { rollupAsks, clearHealth, recordCall, loadHealth } from '../src/db/health';
import { buildPopupSnapshot } from '../src/db/snapshot';
import { ApiError } from '../src/lib/util';
import { classifyAutofillError, isFlagged, successRate } from '../src/lib/health';

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 13); // Thu 8 Oct 2026, 14:00 London (BST)
const TODAY = '2026-10-08';
const RPC = 'https://a2a.manyfold.test/agents/concierge/rpc';

async function call(method: string, path: string, o: { user?: string; body?: unknown; now?: number } = {}) {
  const headers: Record<string, string> = { 'x-now': String(o.now ?? NOW), 'x-dev-ip': '203.0.113.9' };
  if (o.user) headers['x-dev-user'] = o.user;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
  return { status: res.status, json: (await res.json()) as any };
}

const row = (feature: string, day = TODAY) => env.DB.prepare('SELECT * FROM health_daily WHERE day = ? AND feature = ?').bind(day, feature).first<any>();
const ask = (id: string, at: number, status: string, o: { who?: string; took?: number; error?: string } = {}) =>
  env.DB.prepare('INSERT INTO asks (id, asked_at, ip_hash, text, status, error, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, at, o.who ?? 'visitor1', 'free art', status, o.error ?? null, status === 'pending' ? null : at + (o.took ?? 1000)).run();

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('hc_admin', 'hc_admin@test.dev', 'Admin', 'admin', 100, 1, ?)").bind(NOW - 90 * DAY),
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('hc_user', 'hc_user@test.dev', 'Poster', 'user', 50, 1, ?)").bind(NOW - 90 * DAY),
    env.DB.prepare(`INSERT INTO popups (id, slug, title, host, category, price_type, borough, lat, lng, geohash, address, start_at, end_at, status, created_by, created_at, updated_at, hot, is_example)
      VALUES ('hc_1', 'hc-1', 'Free Health Market', 'Host', 'market', 'free', 'Hackney', 51.53, -0.07, 'gcpvj', 'A', ?, ?, 'community', 'hc_user', ?, ?, 1, 0)`).bind(NOW + HOUR, NOW + 3 * DAY, NOW, NOW),
  ]);
  await buildPopupSnapshot(env.DB, NOW);
});

beforeEach(async () => {
  clearHealth();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM asks'),
    env.DB.prepare('DELETE FROM health_daily'),
    env.DB.prepare("DELETE FROM settings WHERE key = 'health_test'"),
    env.DB.prepare("DELETE FROM agents WHERE id NOT IN ('scout', 'triage', 'checker')"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('the rules', () => {
  it('leaves what is not ours out of the success rate, and flags a bad day only with enough calls', () => {
    expect(successRate({ ok: 0, failed: 0 })).toBeNull();
    expect(successRate({ ok: 3, failed: 1 })).toBe(0.75);
    expect(isFlagged({ ok: 3, failed: 1 })).toBe(false); // only 4 calls
    expect(isFlagged({ ok: 3, failed: 2 })).toBe(true); // 5 calls, 60%
    expect(isFlagged({ ok: 4, failed: 1 })).toBe(false); // exactly 80%
    expect(isFlagged({ ok: 0, failed: 0 })).toBe(false);
  });

  it('counts the model failing as ours, a site that blocks us as not, and a refusal as nothing', () => {
    expect(classifyAutofillError(new ApiError(503, 'ai_failed', 'x'))).toBe('failed');
    expect(classifyAutofillError(new ApiError(503, 'ai_quota', 'x'))).toBe('failed');
    expect(classifyAutofillError(new Error('boom'))).toBe('failed');
    expect(classifyAutofillError(new ApiError(422, 'unreadable_link', 'x'))).toBe('other');
    expect(classifyAutofillError(new ApiError(502, 'fetch_failed', 'x'))).toBe('other');
    expect(classifyAutofillError(new ApiError(422, 'unreadable_text', 'x'))).toBe('other');
    expect(classifyAutofillError(new ApiError(429, 'daily_limit', 'x'))).toBeNull();
    expect(classifyAutofillError(new ApiError(501, 'ai_unavailable', 'x'))).toBeNull();
    expect(classifyAutofillError(new ApiError(400, 'url_invalid', 'x'))).toBeNull();
  });
});

describe('Ask roll-up', () => {
  it('counts a day of questions from the asks table and leaves out the admin test and questions still waiting', async () => {
    await ask('a1', NOW - 3 * HOUR, 'done', { took: 8000 });
    await ask('a2', NOW - 2 * HOUR, 'done', { took: 12_000 });
    await ask('a3', NOW - HOUR, 'failed', { took: 90_000, error: 'No answer within 90 seconds.' });
    await ask('a4', NOW - 1000, 'pending');
    await ask('a5', NOW - 4 * HOUR, 'done', { who: 'admin-test', took: 500 });
    await rollupAsks(env.DB, NOW);
    expect(await row('ask')).toMatchObject({ ok: 2, failed: 1, other: 0, ms_sum: 110_000, ms_max: 90_000, last_error: 'No answer within 90 seconds.' });
  });

  it('is the same when it runs again, and keeps yesterday after the questions are purged', async () => {
    await ask('b1', NOW - DAY, 'done', { took: 5000 });
    await ask('b2', NOW - HOUR, 'done', { took: 7000 });
    await rollupAsks(env.DB, NOW);
    await rollupAsks(env.DB, NOW);
    expect(await row('ask', '2026-10-07')).toMatchObject({ ok: 1, ms_sum: 5000 });
    expect(await row('ask')).toMatchObject({ ok: 1, ms_sum: 7000 });
    await env.DB.prepare('DELETE FROM asks').run();
    await rollupAsks(env.DB, NOW + 2 * DAY); // two days later: nothing to count, nothing overwritten
    expect(await row('ask', '2026-10-07')).toMatchObject({ ok: 1 });
  });

  it('writes nothing for a day with no questions', async () => {
    await rollupAsks(env.DB, NOW);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM health_daily').first<{ n: number }>())!.n).toBe(0);
  });

  it('runs from the hourly cron', async () => {
    await ask('c1', NOW - HOUR, 'done');
    const { runCron } = await import('../src/cron');
    await runCron('0 * * * *', env, NOW);
    expect(await row('ask')).toMatchObject({ ok: 1 });
  });
});

describe('autofill recording', () => {
  const answer = { title: 'Kimchi Club pop-up', host: 'Kimchi Club', category: 'food', address: '12 Rivington Street, EC2A 3DU',
    start_date: '2026-10-10', end_date: '2026-10-11', hours_text: null, price_text: null, description: null, unsure: [] };
  let n = 0;
  const poster = async () => {
    const id = `hc_p${++n}`;
    await env.DB.prepare('INSERT INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES (?, ?, ?, ?, 50, 1, ?)').bind(id, `${id}@test.dev`, id, 'user', NOW - 60 * DAY).run();
    return id;
  };
  const extract = async (body: unknown, user?: string) => call('POST', '/extract', { user: user ?? (await poster()), body });

  it('counts a working request with its time', async () => {
    vi.spyOn(env.AI, 'run').mockResolvedValue({ response: answer } as never);
    expect((await extract({ text: 'Kimchi Club this weekend, Rivington St' })).status).toBe(200);
    expect(await row('autofill')).toMatchObject({ ok: 1, failed: 0, other: 0 });
  });

  it('counts the model failing as failed and keeps the reason', async () => {
    vi.spyOn(env.AI, 'run').mockRejectedValue(new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons'));
    expect((await extract({ text: 'Some pop-up on Saturday in Hackney' })).status).toBe(503);
    expect(await row('autofill')).toMatchObject({ ok: 0, failed: 1, last_error: 'ai_quota' });
  });

  it('counts a page or text with nothing in it as other, not failed', async () => {
    vi.spyOn(env.AI, 'run').mockResolvedValue({ response: { title: null, unsure: [] } } as never);
    expect((await extract({ text: 'hello hello hello' })).status).toBe(422);
    expect(await row('autofill')).toMatchObject({ ok: 0, failed: 0, other: 1, ms_sum: 0 });
  });

  it('counts a page the model could not read as failed, not as the site blocking us', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html><body><p>Nothing here</p></body></html>', { headers: { 'content-type': 'text/html' } }));
    vi.spyOn(env.AI, 'run').mockRejectedValue(new Error('AiError: 3000: model is down'));
    expect((await extract({ url: 'https://example.com/no-event' })).status).toBe(422);
    expect(await row('autofill')).toMatchObject({ failed: 1, other: 0, last_error: 'ai_error' });
  });

  it('counts a request refused before any work as nothing', async () => {
    const u = await poster();
    expect((await extract({}, u)).status).toBe(400);
    expect((await extract({ url: 'http://127.0.0.1/' }, u)).status).toBe(400);
    expect(await row('autofill')).toBeNull();
    // a signed-out request never reaches the handler's work either
    expect((await call('POST', '/extract', { body: { text: 'x' } })).status).toBe(401);
    expect(await row('autofill')).toBeNull();
  });

  it('adds up over a day, keeping the slowest', async () => {
    await recordCall(env.DB, 'autofill', NOW, 'ok', 800);
    await recordCall(env.DB, 'autofill', NOW, 'ok', 2200);
    await recordCall(env.DB, 'autofill', NOW, 'failed', 400, 'ai_failed');
    await recordCall(env.DB, 'autofill', NOW, 'ok', 100);
    expect(await row('autofill')).toMatchObject({ ok: 3, failed: 1, ms_sum: 3500, ms_max: 2200, last_error: 'ai_failed' });
  });
});


describe('public MCP recording', () => {
  const rpc = (body: unknown, auth?: string) => exports.default.fetch(new Request('http://spotted.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-now': String(NOW), 'x-dev-ip': '203.0.113.31', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
  })).then(async r => ({ status: r.status, json: (await r.json()) as any }));
  const callTool = (name: string, args: unknown) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('counts a search that worked, and a lookup of a pop-up that is not there as not ours', async () => {
    expect((await callTool('search_popups', { when: 'all' })).json.result.isError).toBeUndefined();
    const miss = await callTool('get_popup', { id: 'no-such-popup' });
    expect(miss.json.result.isError).toBe(true);
    expect(await row('mcp')).toMatchObject({ ok: 1, failed: 0, other: 1 });
  });

  it('counts a tool that broke on our side as failed, with the tool name', async () => {
    // only the pop-up lookup fails, so the health write itself still works
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation(sql => { if (sql.includes('FROM popups WHERE id')) throw new Error('D1 is down'); return real(sql); });
    const r = await callTool('get_popup', { id: 'hc-1' });
    spy.mockRestore();
    expect(r.json.result.isError).toBe(true);
    expect(await row('mcp')).toMatchObject({ failed: 1, last_error: 'get_popup: D1 is down' });
  });

  it('does not count listing the tools, an unknown tool, or an agent key', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await callTool('no_such_tool', {});
    await callTool('submit_draft', {}); // needs an agent key
    expect(await row('mcp')).toBeNull();
  });
});

describe('GET /admin/health', () => {
  it('is for admins only', async () => {
    expect((await call('GET', '/admin/health')).status).toBe(401);
    expect((await call('GET', '/admin/health', { user: 'hc_user' })).status).toBe(403);
    expect((await call('GET', '/admin/health', { user: 'hc_admin' })).status).toBe(200);
  });

  it('gives 14 days for each feature with quiet days as zeros, and today from the live asks', async () => {
    await recordCall(env.DB, 'autofill', NOW - 2 * DAY, 'ok', 1000);
    await recordCall(env.DB, 'autofill', NOW, 'failed', 3000, 'ai_failed');
    for (let i = 0; i < 4; i++) await ask(`d${i}`, NOW - (i + 1) * 1000, i === 0 ? 'failed' : 'done', { took: 2000, error: 'No answer' });
    const h = (await call('GET', '/admin/health', { user: 'hc_admin' })).json.health;
    expect(h.features.map((f: any) => f.feature)).toEqual(['ask', 'autofill', 'mcp']);
    const [a, f] = h.features;
    expect(a.days).toHaveLength(14);
    expect(a.days[13]).toMatchObject({ day: TODAY, ok: 3, failed: 1, avg_ms: 2000, max_ms: 2000 }); // no cron has run yet
    expect(a.rate_today).toBe(0.75);
    expect(a.flagged).toBe(false);
    expect(f.days[11]).toMatchObject({ day: '2026-10-06', ok: 1 });
    expect(f.days[12]).toMatchObject({ ok: 0, failed: 0, avg_ms: null });
    expect(f.days[13]).toMatchObject({ failed: 1 });
    expect(f.last_error).toBe('ai_failed');
    expect(f.test).toBeNull();
  });

  it('flags a feature that failed most of today with at least five calls', async () => {
    for (let i = 0; i < 5; i++) await recordCall(env.DB, 'autofill', NOW, i === 0 ? 'ok' : 'failed', 100, 'ai_failed');
    const f = (await call('GET', '/admin/health', { user: 'hc_admin' })).json.health.features[1];
    expect(f).toMatchObject({ rate_today: 0.2, flagged: true });
  });
});

describe('Test now', () => {
  const found = { title: 'Marmalade Market', host: 'Marmalade Co', category: 'market', address: '14 Mare Street, E8 3QE', start_date: '2026-11-07', end_date: '2026-11-08', hours_text: null, price_text: 'Free', description: null, unsure: [] };
  const post = (user: string | undefined, feature: unknown, now = NOW) => call('POST', '/admin/health/test', { user, body: { feature }, now });

  it('is for admins, and needs a known feature', async () => {
    expect((await post(undefined, 'autofill')).status).toBe(401);
    expect((await post('hc_user', 'autofill')).status).toBe(403);
    expect((await post('hc_admin', 'nope')).status).toBe(400);
    expect((await post('hc_admin', undefined)).status).toBe(400);
  });

  it('passes autofill when the model finds a name and a date in the sample, and shows it in the panel', async () => {
    const run = vi.spyOn(env.AI, 'run').mockResolvedValue({ response: found } as never);
    const r = await post('hc_admin', 'autofill');
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ feature: 'autofill', ok: true, at: NOW });
    expect(r.json.result.detail).toContain('Marmalade Market');
    expect(run).toHaveBeenCalledOnce();
    const h = (await call('GET', '/admin/health', { user: 'hc_admin' })).json.health;
    expect(h.features[1].test).toMatchObject({ ok: true });
    // a test is not a visitor: it adds nothing to the day's numbers
    expect(await row('autofill')).toBeNull();
  });

  it('fails autofill with the reason when the model is down or answers with nothing', async () => {
    vi.spyOn(env.AI, 'run').mockRejectedValueOnce(new Error('AiError: 3000: down'));
    const down = await post('hc_admin', 'autofill', NOW);
    expect(down.json.result).toMatchObject({ ok: false });
    expect(down.json.result.detail).toMatch(/did not work/);
    vi.spyOn(env.AI, 'run').mockResolvedValue({ response: { title: null, unsure: [] } } as never);
    const empty = await post('hc_admin', 'autofill', NOW + 2 * 60_000);
    expect(empty.json.result.ok).toBe(false);
  });

  it('allows one test a minute for each feature', async () => {
    vi.spyOn(env.AI, 'run').mockResolvedValue({ response: found } as never);
    expect((await post('hc_admin', 'autofill')).status).toBe(200);
    const again = await post('hc_admin', 'autofill', NOW + 30_000);
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe('test_too_soon');
    expect((await post('hc_admin', 'autofill', NOW + 61_000)).status).toBe(200);
  });


  describe('MCP', () => {
    it('passes when a search finds a live pop-up with a link on this site and it can be fetched', async () => {
      const r = await post('hc_admin', 'mcp');
      expect(r.status).toBe(200);
      expect(r.json.result).toMatchObject({ feature: 'mcp', ok: true });
      expect(r.json.result.detail).toMatch(/fetching it worked/);
      expect(await row('mcp')).toBeNull(); // a test is not a visitor
      expect((await call('GET', '/admin/health', { user: 'hc_admin' })).json.health.features[2].test).toMatchObject({ ok: true });
      expect((await post('hc_admin', 'mcp', NOW + 1000)).status).toBe(429);
    });

    it('fails with the reason when the public list is empty', async () => {
      await env.DB.prepare("UPDATE popups SET status = 'removed' WHERE id = 'hc_1'").run();
      await buildPopupSnapshot(env.DB, NOW);
      const r = await post('hc_admin', 'mcp');
      await env.DB.prepare("UPDATE popups SET status = 'community' WHERE id = 'hc_1'").run();
      await buildPopupSnapshot(env.DB, NOW);
      expect(r.json.result.ok).toBe(false);
      expect(r.json.result.detail).toMatch(/no pop-ups/);
    });
  });

  describe('Ask', () => {
    const mf = { state: 'working', text: '' };
    const fakeManyfold = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.method === 'message/send') return Response.json({ jsonrpc: '2.0', id: body.id, result: { kind: 'task', id: 'task-hc', contextId: 'ctx', status: { state: 'submitted' } } });
      if (body.method === 'tasks/get') return Response.json({ jsonrpc: '2.0', id: body.id, result: { kind: 'task', id: body.params.id, status: { state: mf.state }, artifacts: mf.text ? [{ artifactId: 'a', parts: [{ kind: 'text', text: mf.text }] }] : [] } });
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    const concierge = async () => {
      const created = await call('POST', '/admin/agents', { user: 'hc_admin', body: { role: 'concierge' } });
      expect(created.status).toBe(201);
      const patch = await call('PATCH', `/admin/agents/${created.json.id}`, { user: 'hc_admin', body: { rpc_url: RPC, token: 'mf-caller-token-0123456789-wxyz', enabled: true } });
      expect(patch.status).toBe(200);
    };
    beforeEach(() => Object.assign(mf, { state: 'working', text: '' }));

    it('says so at once when no Concierge is on', async () => {
      const r = await post('hc_admin', 'ask');
      expect(r.status).toBe(200);
      expect(r.json.result).toMatchObject({ feature: 'ask', ok: false });
      expect(r.json.result.detail).toMatch(/No Concierge/);
      expect(r.json.id).toBeUndefined();
    });

    it('starts a question, waits, and passes when the Concierge picks a pop-up from the public list', async () => {
      await concierge();
      fakeManyfold();
      const start = await post('hc_admin', 'ask');
      expect(start.json.result).toMatchObject({ ok: null });
      const id = start.json.id as string;
      expect((await env.DB.prepare('SELECT ip_hash FROM asks WHERE id = ?').bind(id).first<any>())!.ip_hash).toBe('admin-test');

      expect((await post('hc_admin', 'ask', NOW + 1000)).status).toBe(429);
      expect((await call('GET', `/admin/health/test/ask/${id}`, { user: 'hc_user', now: NOW + 3000 })).status).toBe(403);

      const waiting = await call('GET', `/admin/health/test/ask/${id}`, { user: 'hc_admin', now: NOW + 3000 });
      expect(waiting.json).toMatchObject({ status: 'pending', result: { ok: null } });

      mf.state = 'completed';
      mf.text = JSON.stringify({ picks: [{ id: 'hc_1', reason: 'Free.' }, { id: 'invented', reason: 'No.' }], note: '' });
      const done = await call('GET', `/admin/health/test/ask/${id}`, { user: 'hc_admin', now: NOW + 6000 });
      expect(done.json.status).toBe('done');
      expect(done.json.result).toMatchObject({ ok: true, id, ms: 6000, detail: 'The Concierge picked 1 pop-up.' });

      const h = (await call('GET', '/admin/health', { user: 'hc_admin' })).json.health;
      expect(h.features[0].test).toMatchObject({ ok: true });
      // the admin's question is not a visitor's
      await rollupAsks(env.DB, NOW + 10_000);
      expect(await row('ask')).toBeNull();
    });

    it('fails with the reason when the Concierge does not answer properly', async () => {
      await concierge();
      fakeManyfold();
      const id = (await post('hc_admin', 'ask')).json.id as string;
      mf.state = 'failed';
      const r = await call('GET', `/admin/health/test/ask/${id}`, { user: 'hc_admin', now: NOW + 3000 });
      expect(r.json.result.ok).toBe(false);
      expect(r.json.result.detail).toContain('failed');
    });

    it('fails when it answers but picks nothing from the public list', async () => {
      await concierge();
      fakeManyfold();
      const id = (await post('hc_admin', 'ask')).json.id as string;
      mf.state = 'completed';
      mf.text = JSON.stringify({ picks: [{ id: 'invented', reason: 'x' }], note: 'nothing' });
      const r = await call('GET', `/admin/health/test/ask/${id}`, { user: 'hc_admin', now: NOW + 3000 });
      expect(r.json.result).toMatchObject({ ok: false, detail: 'The Concierge answered, but picked nothing from the public list.' });
    });

    it('only follows the admin tests, not a visitor question', async () => {
      await ask('visitor_q', NOW, 'pending');
      expect((await call('GET', '/admin/health/test/ask/visitor_q', { user: 'hc_admin' })).status).toBe(404);
      expect((await call('GET', '/admin/health/test/ask/nope', { user: 'hc_admin' })).status).toBe(404);
    });
  });
});

describe('before migration 0028 is applied', () => {
  it('shows nothing and breaks nothing', async () => {
    await env.DB.prepare('DROP TABLE health_daily').run();
    clearHealth();
    await recordCall(env.DB, 'autofill', NOW, 'ok', 100); // must not throw
    await rollupAsks(env.DB, NOW).catch(() => {}); // the cron catches this one
    expect((await call('GET', '/admin/health', { user: 'hc_admin' })).json).toEqual({ health: null });
    expect(await loadHealth(env.DB, NOW)).toBeNull();
  });
});
