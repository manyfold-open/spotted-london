import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { checkRuns, dispatchDue, nextRunAt } from '../src/db/agents';
import { checkRpcUrl, readResult } from '../src/lib/a2a';
import { seal, unseal } from '../src/lib/seal';

const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London (BST)
const RPC = 'https://a2a.manyfold.test/agents/abc/rpc';

async function call(method: string, path: string, o: { user?: string; body?: unknown; now?: number } = {}) {
  const headers: Record<string, string> = { 'x-now': String(o.now ?? NOW) };
  if (o.user) headers['x-dev-user'] = o.user;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
  return { status: res.status, json: (await res.json()) as any };
}

let rpcId = 0;
async function mcp(method: string, params: unknown, key?: string, now = NOW) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-now': String(now) };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await exports.default.fetch(new Request('http://spotted.test/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }));
  return { status: res.status, json: res.status === 202 ? null : (await res.json()) as any };
}
const tool = async (name: string, args: Record<string, unknown>, key?: string) => (await mcp('tools/call', { name, arguments: args }, key)).json.result;

let n = 0;
async function user(role = 'user') {
  const id = `ag${++n}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare('INSERT INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, ?, 100, 10, 1, ?)')
    .bind(id, `${id}@test.dev`, id, role, NOW - 90 * DAY).run();
  return id;
}

/** Fake Manyfold: message/stream answers with a task over SSE, tasks/get with the given state. */
function fakeManyfold(taskState = 'working', text = '') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.method === 'message/stream') {
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { kind: 'task', id: 'task-1', contextId: 'ctx', status: { state: 'submitted' } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (body.method === 'tasks/get') {
      if (String(body.params.id).startsWith('probe-')) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Task not found' } });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { kind: 'task', id: body.params.id, status: { state: taskState }, artifacts: text ? [{ artifactId: 'a', parts: [{ kind: 'text', text }] }] : [] } });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  });
}

let admin: string;
beforeEach(async () => {
  admin = await user('admin');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agent_notes'),
    env.DB.prepare('DELETE FROM agent_runs'),
    env.DB.prepare("UPDATE agents SET enabled = 0, rpc_url = NULL, token_sealed = NULL, token_hint = NULL, key_hash = NULL, key_hint = NULL, next_run_at = NULL, max_items = 20, instructions = NULL"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

/** Connects an agent to the fake Manyfold and returns its Spotted key. */
async function connect(id: string) {
  const patch = await call('PATCH', `/admin/agents/${id}`, { user: admin, body: { rpc_url: RPC, token: 'mf-caller-token-0123456789-wxyz' } });
  expect(patch.status).toBe(200);
  const key = await call('POST', `/admin/agents/${id}/key`, { user: admin });
  expect(key.status).toBe(201);
  return key.json.key as string;
}

async function startRun(id: string) {
  const spy = fakeManyfold();
  const r = await call('POST', `/admin/agents/${id}/run`, { user: admin });
  expect(r.status).toBe(201);
  spy.mockRestore();
  return r.json.runs[0].id as string;
}

const draft = (runId: string, over: Record<string, unknown> = {}) => ({
  run_id: runId, title: 'Kinfolk Ceramics Sample Sale', category: 'sample', start_date: '2026-10-03', end_date: '2026-10-04',
  lat: 51.5358, lng: -0.1253, address: 'Coal Drops Yard, N1C 4AB', area: "King's Cross", source_url: 'https://kinfolk.test/sale',
  confidence: 'high', note_for_admin: 'Brand site confirms both days.', ...over,
});

describe('MCP server, public', () => {
  it('initialises and lists only the public tools without a key', async () => {
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.capabilities.tools).toBeTruthy();
    const list = await mcp('tools/list', {});
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['search_popups', 'get_popup']);
  });

  it('answers notifications with 202 and no body', async () => {
    const res = await exports.default.fetch(new Request('http://spotted.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }));
    expect(res.status).toBe(202);
  });

  it('searches public pop-ups and reads one by slug', async () => {
    const poster = await user('admin');
    const made = await call('POST', '/popups', { user: poster, body: { title: 'Matcha Lab by Kettl', category: 'food', lat: 51.5226, lng: -0.0781, address: 'Redchurch Street, E2', borough: 'Shoreditch', start_at: NOW + DAY, end_at: NOW + 3 * DAY } });
    expect(made.status).toBe(201);
    const found = await tool('search_popups', { query: 'matcha' });
    expect(found.isError).toBeUndefined();
    const hit = found.structuredContent.popups.find((p: { title: string }) => p.title === 'Matcha Lab by Kettl');
    expect(hit.url).toBe(`http://spotted.test/p/${made.json.slug}`);
    expect(hit.dates).toBe('2026-10-01 to 2026-10-03');
    const one = await tool('get_popup', { id: hit.url });
    expect(one.structuredContent.area).toBe('Shoreditch');
  });

  it('refuses agent tools and unknown keys', async () => {
    const r = await tool('submit_draft', { run_id: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/needs an agent key/);
    expect((await mcp('tools/list', {}, 'spk_nope')).status).toBe(401);
  });
});

describe('agent settings', () => {
  it('is admin only', async () => {
    expect((await call('GET', '/admin/agents', { user: await user() })).status).toBe(403);
  });

  it('never sends secrets back, only their last four characters', async () => {
    const key = await connect('scout');
    expect(key).toMatch(/^spk_/);
    const view = await call('GET', '/admin/agents', { user: admin });
    const scout = view.json.agents.find((a: { id: string }) => a.id === 'scout');
    expect(scout).toMatchObject({ connected: true, token_hint: '…wxyz', key_hint: `…${key.slice(-4)}` });
    const text = JSON.stringify(view.json);
    expect(text).not.toContain('mf-caller-token');
    expect(text).not.toContain(key);
    expect(view.json.mcp_url).toBe('http://spotted.test/mcp');
    const row = await env.DB.prepare("SELECT token_sealed FROM agents WHERE id = 'scout'").first<{ token_sealed: string }>();
    expect(row!.token_sealed).not.toContain('mf-caller');
    expect(await unseal(env.AGENTS_KEY, row!.token_sealed)).toBe('mf-caller-token-0123456789-wxyz');
  });

  it('only switches on a connected agent, then schedules its next run in London time', async () => {
    const off = await call('PATCH', '/admin/agents/triage', { user: admin, body: { enabled: true } });
    expect(off.status).toBe(409);
    expect(off.json.error.code).toBe('agent_not_connected');
    await connect('triage');
    const on = await call('PATCH', '/admin/agents/triage', { user: admin, body: { enabled: true, schedule: 'daily', run_hour: 7 } });
    expect(on.status).toBe(200);
    expect(on.json.next_run_at).toBe(Date.UTC(2026, 9, 1, 6)); // Thu 1 Oct 07:00 BST
  });

  it('rejects private and non-https A2A addresses', async () => {
    expect(() => checkRpcUrl('http://a2a.manyfold.test/rpc', false)).toThrow(/https/);
    expect(() => checkRpcUrl('https://10.0.0.1/rpc', false)).toThrow(/private network/);
    expect(() => checkRpcUrl('https://user:pw@a2a.manyfold.test/rpc', false)).toThrow(/user name/);
    expect(checkRpcUrl(' https://a2a.manyfold.test/rpc#x ', false)).toBe('https://a2a.manyfold.test/rpc');
    const bad = await call('PATCH', '/admin/agents/scout', { user: admin, body: { rpc_url: 'not a url' } });
    expect(bad.json.error.code).toBe('rpc_url_invalid');
  });

  it('tests the connection without starting a turn', async () => {
    await connect('scout');
    const spy = fakeManyfold();
    const r = await call('POST', '/admin/agents/scout/test', { user: admin });
    expect(r.status).toBe(200);
    expect(JSON.parse(String(spy.mock.calls[0][1]!.body)).method).toBe('tasks/get');
  });

  it('treats "no such task" as a working connection, and 401 as a bad token', async () => {
    await connect('scout');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('task not found', { status: 404 }));
    expect((await call('POST', '/admin/agents/scout/test', { user: admin })).status).toBe(200);
    spy.mockImplementation(async () => new Response('no', { status: 401 }));
    expect((await call('POST', '/admin/agents/scout/test', { user: admin })).json.error.code).toBe('agent_token_rejected');
  });

  it('revoking the key switches the agent off', async () => {
    await connect('checker');
    await call('PATCH', '/admin/agents/checker', { user: admin, body: { enabled: true } });
    const r = await call('DELETE', '/admin/agents/checker/key', { user: admin });
    expect(r.json).toMatchObject({ enabled: false, key_hint: null });
  });
});

describe('connect with Manyfold', () => {
  function fakeConnect(pollAnswers: unknown[]) {
    const answers = [...pollAnswers];
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://api.manyfold.ai/api/connect/a2a/start') {
        return Response.json({ requestId: 'a2c_1', userCode: 'WXYZ-2345', authUrl: 'https://manyfold.ai/connect/a2a?request=a2c_1&code=WXYZ-2345', deviceCode: 'mf_cnx_device-secret', expiresAt: new Date(NOW + 15 * 60_000).toISOString() }, { status: 201 });
      }
      if (url === 'https://api.manyfold.ai/api/connect/a2a/poll') {
        expect(JSON.parse(String(init!.body))).toEqual({ deviceCode: 'mf_cnx_device-secret' });
        return Response.json(answers.shift() ?? { status: 'pending' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it('keeps the device code on the server and stores the approved agent', async () => {
    const spy = fakeConnect([
      { status: 'pending' },
      { status: 'approved', userEmail: 'zack@test.dev', agents: [
        { agentId: 'agt_1', name: 'Spotted Scout', rpcUrl: 'https://api.manyfold.ai/api/a2a/agents/agt_1/rpc', cardUrl: 'https://api.manyfold.ai/api/a2a/agents/agt_1/card', token: 'mf-granted-token-0123456789-abcd', expiresAt: null },
        { agentId: 'agt_2', name: 'Other', rpcUrl: 'https://api.manyfold.ai/api/a2a/agents/agt_2/rpc', cardUrl: 'x', token: 'mf-other-token-000000000000', expiresAt: null },
      ] },
    ]);
    const start = await call('POST', '/admin/agents/scout/connect', { user: admin });
    expect(start.status).toBe(201);
    expect(start.json).toMatchObject({ user_code: 'WXYZ-2345', auth_url: 'https://manyfold.ai/connect/a2a?request=a2c_1&code=WXYZ-2345' });
    expect(JSON.stringify(start.json)).not.toContain('mf_cnx_');
    expect(JSON.parse(String(spy.mock.calls[0][1]!.body))).toEqual({ clientName: 'Spotted London (Scout)' }); // APP_URL is http in tests

    expect((await call('POST', '/admin/agents/scout/connect/poll', { user: admin })).json.status).toBe('pending');
    const done = await call('POST', '/admin/agents/scout/connect/poll', { user: admin });
    expect(done.json).toMatchObject({ status: 'approved', manyfold_agent: 'Spotted Scout', ignored: 1, agent: { connected: true, token_hint: '…abcd', rpc_url: 'https://api.manyfold.ai/api/a2a/agents/agt_1/rpc' } });
    expect(JSON.stringify(done.json)).not.toContain('mf-granted-token');
    const row = await env.DB.prepare("SELECT token_sealed FROM agents WHERE id = 'scout'").first<{ token_sealed: string }>();
    expect(await unseal(env.AGENTS_KEY, row!.token_sealed)).toBe('mf-granted-token-0123456789-abcd');
    // the request is used up
    expect((await call('POST', '/admin/agents/scout/connect/poll', { user: admin })).json.status).toBe('expired');
  });

  it('reports a denied request and is admin only', async () => {
    fakeConnect([{ status: 'denied' }]);
    expect((await call('POST', '/admin/agents/triage/connect', { user: await user() })).status).toBe(403);
    await call('POST', '/admin/agents/triage/connect', { user: admin });
    expect((await call('POST', '/admin/agents/triage/connect/poll', { user: admin })).json.status).toBe('denied');
    const a = await env.DB.prepare("SELECT rpc_url FROM agents WHERE id = 'triage'").first<{ rpc_url: string | null }>();
    expect(a!.rpc_url).toBeNull();
  });
});

describe('agent runs', () => {
  it('starts a run on Manyfold with a brief that carries the run id and admin notes', async () => {
    await connect('scout');
    await call('PATCH', '/admin/agents/scout', { user: admin, body: { instructions: 'Focus on sample sales.' } });
    const spy = fakeManyfold();
    const r = await call('POST', '/admin/agents/scout/run', { user: admin });
    expect(r.status).toBe(201);
    const run = r.json.runs[0];
    expect(run).toMatchObject({ status: 'running', trigger: 'manual' });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(RPC);
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer mf-caller-token-0123456789-wxyz');
    const sent = JSON.parse(String(init!.body));
    expect(sent.method).toBe('message/stream');
    expect(sent.params.message.messageId).toBe(`spotted-run-${run.id}`);
    const text = sent.params.message.parts[0].text as string;
    expect(text).toContain(`run_id "${run.id}"`);
    expect(text).toContain('Focus on sample sales.');
    expect(text).toContain('Today in London is Wednesday, 30 September 2026, 14:00.');
    // one run at a time
    const again = await call('POST', '/admin/agents/scout/run', { user: admin });
    expect(again.json.error.code).toBe('agent_busy');
  });

  it('records a run that could not start', async () => {
    await connect('scout');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 401 }));
    const r = await call('POST', '/admin/agents/scout/run', { user: admin });
    expect(r.json.error.code).toBe('agent_token_rejected');
    const view = await call('GET', '/admin/agents', { user: admin });
    expect(view.json.agents.find((a: { id: string }) => a.id === 'scout').runs[0]).toMatchObject({ status: 'failed' });
  });

  it('scout drafts land in the review queue as pending, with the agent note, and never twice', async () => {
    const key = await connect('scout');
    const runId = await startRun('scout');
    const tools = (await mcp('tools/list', {}, key)).json.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(['search_popups', 'get_popup', 'find_place', 'check_duplicates', 'submit_draft', 'finish_run']);

    const sent = await tool('submit_draft', draft(runId), key);
    expect(sent.structuredContent).toMatchObject({ sent: true, status: 'pending' });
    const row = await env.DB.prepare('SELECT * FROM popups WHERE id = ?').bind(sent.structuredContent.id).first<any>();
    expect(row).toMatchObject({ status: 'pending', created_by: 'agent_scout', borough: "King's Cross", start_at: Date.UTC(2026, 9, 2, 23), source_url: 'https://kinfolk.test/sale' });

    const again = await tool('submit_draft', draft(runId, { title: 'Kinfolk Ceramics Sample Sale 2026' }), key);
    expect(again.structuredContent.sent).toBe(false);

    const queue = await call('GET', '/admin/queue', { user: admin });
    const item = queue.json.items.find((p: { id: string }) => p.id === sent.structuredContent.id);
    expect(item.flags).toContain('by_agent');
    expect(item.agent_notes[0]).toMatchObject({ agent_id: 'scout', verdict: 'looks_real', note: 'Brand site confirms both days.' });

    // approving resolves the note
    await call('POST', `/admin/popups/${item.id}/decision`, { user: admin, body: { action: 'approve' } });
    const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_notes WHERE popup_id = ? AND resolved_at IS NULL').bind(item.id).first<{ n: number }>();
    expect(open!.n).toBe(0);
  });

  it('accepts a pop-up that started weeks ago and is still running, with its real start date', async () => {
    const key = await connect('scout');
    const runId = await startRun('scout');
    const sent = await tool('submit_draft', draft(runId, { title: 'InterStellar BBQ Residency', lat: 51.5136, lng: -0.0867, start_date: '2026-09-04', end_date: '2026-10-25' }), key);
    expect(sent.structuredContent.sent).toBe(true);
    const row = await env.DB.prepare('SELECT start_at FROM popups WHERE id = ?').bind(sent.structuredContent.id).first<{ start_at: number }>();
    expect(row!.start_at).toBe(Date.UTC(2026, 8, 3, 23)); // 4 Sep 00:00 BST
    const ended = await tool('submit_draft', draft(runId, { title: 'Summer Rooftop Cinema', lat: 51.5033, lng: -0.1196, start_date: '2026-08-01', end_date: '2026-09-20' }), key);
    expect(ended.content[0].text).toMatch(/already ended/);
  });

  it('enforces the per-run limit, the run owner, and finishes the run', async () => {
    const key = await connect('scout');
    await call('PATCH', '/admin/agents/scout', { user: admin, body: { max_items: 1 } });
    const runId = await startRun('scout');
    expect((await tool('submit_draft', draft(runId, { title: 'Oat Milk Bar Pop-up', lat: 51.5145, lng: -0.1419 }), key)).structuredContent.sent).toBe(true);
    const over = await tool('submit_draft', draft(runId, { title: 'Vintage Denim Sale', lat: 51.5205, lng: -0.0712 }), key);
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toMatch(/limit of 1/);

    const triageKey = await connect('triage');
    const wrong = await tool('finish_run', { run_id: runId, summary: 'x' }, triageKey);
    expect(wrong.content[0].text).toMatch(/Unknown run_id/);

    expect((await tool('finish_run', { run_id: runId, summary: 'Found one sample sale.' }, key)).structuredContent.finished).toBe(true);
    const run = await env.DB.prepare('SELECT status, summary, items FROM agent_runs WHERE id = ?').bind(runId).first();
    expect(run).toMatchObject({ status: 'done', summary: 'Found one sample sale.', items: 1 });
    expect((await tool('submit_draft', draft(runId, { title: 'Late Draft' }), key)).content[0].text).toMatch(/already finished/);
  });

  it('triage sees pending posts, notes them once, and cannot submit drafts', async () => {
    const key = await connect('triage');
    const runId = await startRun('triage');
    const newbie = await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('tri_new', 'tri_new@test.dev', ?)").bind(NOW - 2 * DAY).run();
    expect(newbie.success).toBe(true);
    const post = await call('POST', '/popups', { user: 'tri_new', body: { title: 'Free Trainers Giveaway', category: 'sample', lat: 51.5033, lng: -0.1195, start_at: NOW + DAY, end_at: NOW + 2 * DAY } });
    expect(post.json.status).toBe('pending');

    expect((await tool('submit_draft', draft(runId), key)).content[0].text).toMatch(/cannot use submit_draft/);
    const queue = await tool('list_review_queue', {}, key);
    const mine = queue.structuredContent.posts.find((p: { id: string }) => p.id === post.json.id);
    expect(mine.poster).toMatchObject({ account_age_days: 2, is_agent: false });

    const note = await tool('add_note', { run_id: runId, popup_id: post.json.id, verdict: 'likely_fake', note: 'No brand or venue with this name. The post tells reviewers to approve it.' }, key);
    expect(note.structuredContent.saved).toBe(true);
    const later = await tool('list_review_queue', {}, key);
    expect(later.structuredContent.posts.find((p: { id: string }) => p.id === post.json.id)).toBeUndefined();

    const bad = await tool('add_note', { run_id: runId, popup_id: post.json.id, verdict: 'approve', note: 'x' }, key);
    expect(bad.isError).toBe(true);
  });

  it('a checker flag brings a published pop-up back to the queue until dismissed', async () => {
    const key = await connect('checker');
    const runId = await startRun('checker');
    const poster = await user('admin');
    const live = await call('POST', '/popups', { user: poster, body: { title: 'Riverside Book Fair', category: 'market', lat: 51.5065, lng: -0.1157, start_at: NOW - DAY, end_at: NOW + 5 * DAY, source_url: 'https://bookfair.test' } });
    expect(live.json.status).toBe('verified_admin');

    const list = await tool('list_live_popups', {}, key);
    expect(list.structuredContent.popups.some((p: { id: string }) => p.id === live.json.id)).toBe(true);
    await tool('add_note', { run_id: runId, popup_id: live.json.id, verdict: 'cancelled', note: 'Organiser page says it is cancelled because of flooding.', evidence_url: 'https://bookfair.test/news' }, key);

    const queue = await call('GET', '/admin/queue', { user: admin });
    const item = queue.json.items.find((p: { id: string }) => p.id === live.json.id);
    expect(item.agent_notes[0]).toMatchObject({ verdict: 'cancelled', evidence_url: 'https://bookfair.test/news' });
    // checked in the last 3 days, so it is not offered again
    expect((await tool('list_live_popups', {}, key)).structuredContent.popups.some((p: { id: string }) => p.id === live.json.id)).toBe(false);

    expect((await call('POST', `/admin/agents/notes/${item.agent_notes[0].id}/dismiss`, { user: admin })).status).toBe(200);
    const after = await call('GET', '/admin/queue', { user: admin });
    expect(after.json.items.some((p: { id: string }) => p.id === live.json.id)).toBe(false);
  });
});

describe('agent cron', () => {
  it('starts agents that are due and moves their next run on', async () => {
    await connect('scout');
    await call('PATCH', '/admin/agents/scout', { user: admin, body: { enabled: true, schedule: 'hourly' } });
    await env.DB.prepare("UPDATE agents SET next_run_at = ? WHERE id = 'scout'").bind(NOW - 60_000).run();
    const spy = fakeManyfold();
    await dispatchDue(env, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    const a = await env.DB.prepare("SELECT next_run_at FROM agents WHERE id = 'scout'").first<{ next_run_at: number }>();
    expect(a!.next_run_at).toBe(Date.UTC(2026, 8, 30, 14)); // 15:00 BST
    const runs = await env.DB.prepare("SELECT trigger, status, task_id FROM agent_runs WHERE agent_id = 'scout'").all();
    expect(runs.results).toEqual([{ trigger: 'schedule', status: 'running', task_id: 'task-1' }]);
    // a second cron pass at the same time does nothing
    await dispatchDue(env, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('records why a due agent could not start', async () => {
    await connect('checker');
    await call('PATCH', '/admin/agents/checker', { user: admin, body: { enabled: true } });
    await env.DB.prepare("UPDATE agents SET key_hash = NULL, key_hint = NULL, next_run_at = ? WHERE id = 'checker'").bind(NOW - 1).run();
    await dispatchDue(env, NOW);
    const run = await env.DB.prepare("SELECT status, error FROM agent_runs WHERE agent_id = 'checker'").first<{ status: string; error: string }>();
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/Spotted key/);
  });

  it('settles finished runs from Manyfold and times out hung ones', async () => {
    await connect('scout');
    const runId = await startRun('scout');
    fakeManyfold('completed', 'I could not use the Spotted tools.');
    await checkRuns(env, NOW + 10 * 60_000);
    // finished without finish_run: the agent never reached Spotted, so it is not "done"
    const silent = await env.DB.prepare('SELECT status, summary, error FROM agent_runs WHERE id = ?').bind(runId).first<{ status: string; summary: string; error: string }>();
    expect(silent).toMatchObject({ status: 'failed', summary: 'I could not use the Spotted tools.' });
    expect(silent!.error).toMatch(/without reporting back/);

    const key = await call('POST', '/admin/agents/scout/key', { user: admin });
    const second = await startRun('scout');
    await tool('finish_run', { run_id: second, summary: 'Sent 3 drafts.' }, key.json.key);
    fakeManyfold('completed', 'Done, see summary.');
    await checkRuns(env, NOW + 20 * 60_000);
    expect(await env.DB.prepare('SELECT status, summary, error FROM agent_runs WHERE id = ?').bind(second).first()).toEqual({ status: 'done', summary: 'Sent 3 drafts.', error: null });

    await env.DB.prepare("INSERT INTO agent_runs (id, agent_id, trigger, status, task_id, started_at) VALUES ('hung', 'scout', 'schedule', 'running', 'task-9', ?)").bind(NOW - 4 * HOUR).run();
    await checkRuns(env, NOW);
    expect((await env.DB.prepare("SELECT status FROM agent_runs WHERE id = 'hung'").first<{ status: string }>())!.status).toBe('failed');
  });
});

describe('agent helpers', () => {
  it('schedules in London time across the clock change', () => {
    const sat = Date.UTC(2026, 9, 24, 12); // Sat 24 Oct 13:00 BST; clocks go back Sun 25 Oct
    expect(nextRunAt({ schedule: 'daily', run_hour: 7 }, sat)).toBe(Date.UTC(2026, 9, 25, 7)); // Sun 07:00 GMT
    expect(nextRunAt({ schedule: 'weekly', run_hour: 9 }, sat)).toBe(Date.UTC(2026, 9, 26, 9)); // Mon 09:00 GMT
    expect(nextRunAt({ schedule: 'every_6h', run_hour: 8 }, NOW)).toBe(Date.UTC(2026, 8, 30, 19)); // 20:00 BST
    expect(nextRunAt({ schedule: 'manual', run_hour: 8 }, NOW)).toBeNull();
  });

  it('reads A2A results of every shape', () => {
    expect(readResult({ kind: 'status-update', taskId: 't', status: { state: 'TASK_STATE_WORKING' } })).toMatchObject({ taskId: 't', state: 'working' });
    expect(readResult({ kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'hi' }] })).toMatchObject({ text: 'hi', state: 'completed' });
  });

  it('seals with a random IV', async () => {
    const a = await seal(env.AGENTS_KEY, 'secret'), b = await seal(env.AGENTS_KEY, 'secret');
    expect(a).not.toBe(b);
    expect(await unseal(env.AGENTS_KEY, b)).toBe('secret');
    await expect(unseal('another-key-that-is-also-32-characters!', a)).rejects.toThrow(/AGENTS_KEY changed/);
  });
});
