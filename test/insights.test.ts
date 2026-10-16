import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { clearInsights } from '../src/db/insights';

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 86_400_000;

async function user(id: string, role = 'user') {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)")
    .bind(id, `${id}@test.dev`, id, role, NOW - 2 * DAY).run();
  return id;
}
const get = async (path: string, as?: string) => {
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { headers: { 'x-now': String(NOW), ...(as ? { 'x-dev-user': as } : {}) } }));
  return { status: res.status, json: (await res.json()) as any };
};
const setEnv = (k: string, v: unknown) => Object.defineProperty(env, k, { configurable: true, writable: true, value: v });

afterEach(() => { clearInsights(); setEnv('CF_ACCOUNT_ID', undefined); setEnv('CF_ANALYTICS_TOKEN', undefined); vi.restoreAllMocks(); });

describe('GET /admin/insights', () => {
  it('is for admins only', async () => {
    await user('in_plain'); await user('in_boss', 'admin');
    expect((await get('/admin/insights')).status).toBe(401);
    expect((await get('/admin/insights', 'in_plain')).status).toBe(403);
    expect((await get('/admin/insights', 'in_boss')).status).toBe(200);
  });

  it('shows account counts without any secrets, and says what is missing for visitor numbers', async () => {
    const boss = await user('in_boss2', 'admin');
    await user('in_new1'); await user('in_new2');
    const r = await get('/admin/insights?days=7', boss);
    expect(r.json.days).toBe(7);
    expect(r.json.events.status).toBe('not_configured');
    expect(r.json.accounts.total).toBeGreaterThanOrEqual(3);
    expect(r.json.accounts.new_in_period).toBeGreaterThanOrEqual(3);
    expect(r.json.accounts.per_day).toHaveLength(7);
    // agent and system accounts are not people
    expect(JSON.stringify(r.json)).not.toContain('agents.spotted.invalid');
  });

  it('works out what people contributed from the database, leaving agents out', async () => {
    const boss = await user('ct_boss', 'admin');
    const a = await user('ct_a'), b = await user('ct_b');
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('ct_bot', 'ct_bot@agents.spotted.invalid', 'bot', 'user', 0, 0, ?)").bind(NOW - 2 * DAY).run();
    const popup = async (id: string, by: string, status: string, extra: { voters?: number; borough?: string; at?: number } = {}) => {
      await env.DB.prepare(
        `INSERT INTO popups (id, slug, title, category, address, borough, lat, lng, geohash, start_at, end_at, status, created_by, voter_count, created_at, updated_at)
         VALUES (?, ?, ?, 'food', 'x', ?, 51.5, -0.1, 'gcpvj0', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, `${id}-slug`, id, extra.borough ?? 'Soho', NOW - DAY, NOW + 5 * DAY, status, by, extra.voters ?? 0, extra.at ?? NOW - DAY, NOW).run();
    };
    await popup('ct_p1', a, 'community', { voters: 2 });
    await popup('ct_p2', 'ct_bot', 'community');
    await popup('ct_p3', b, 'pending');
    const save = (u: string, p: string, at: number) => env.DB.prepare('INSERT INTO saves (user_id, popup_id, remind, created_at) VALUES (?, ?, 1, ?)').bind(u, p, at).run();
    await save(a, 'ct_p2', NOW - DAY); await save(b, 'ct_p1', NOW - DAY); await save('ct_bot', 'ct_p1', NOW - DAY);
    await env.DB.prepare("INSERT INTO votes (user_id, popup_id, kind, value, weight, created_at) VALUES (?, 'ct_p1', 'existence', 1, 1, ?)").bind(b, NOW - DAY).run();
    // a new account made inside the window, whose first action came 6 hours later
    await env.DB.prepare("INSERT INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('ct_new', 'ct_new@test.dev', 'new', 'user', 0, 1, ?)").bind(NOW - DAY).run();
    await save('ct_new', 'ct_p1', NOW - DAY + 6 * 3_600_000);

    const c = (await get('/admin/insights?days=7&fresh=1', boss)).json.contributions;
    expect(c.by_kind.saves).toBe(3);   // a, b, ct_new; the agent's save is not a person
    expect(c.by_kind.posts).toBe(2);   // a and b; the agent's post is not a person's
    expect(c.by_kind.votes).toBe(1);
    expect(c.activation.acted).toBeGreaterThanOrEqual(1);
    expect(c.posts).toMatchObject({ waiting: 1 });
    expect(c.posts.live).toBeGreaterThanOrEqual(1);
    expect(c.coverage.checked).toBeGreaterThanOrEqual(1);
    expect(c.origin.agents.live).toBeGreaterThanOrEqual(1);
    expect(c.by_category.find((r: any) => r.key === 'food')).toBeTruthy();
    expect(c.by_area.find((r: any) => r.key === 'Soho')).toBeTruthy();
    // no one is named
    expect(JSON.stringify(c)).not.toMatch(/ct_a|ct_b|ct_new|ct_bot|@/);
  });

  it('only accepts 7 or 30 days', async () => {
    const boss = await user('in_boss3', 'admin');
    expect((await get('/admin/insights?days=999', boss)).json.days).toBe(7);
    expect((await get('/admin/insights?days=30', boss)).json.days).toBe(30);
  });

  it('reads the events back from Analytics Engine and fills quiet days with zero', async () => {
    const boss = await user('in_boss4', 'admin');
    setEnv('CF_ACCOUNT_ID', 'acct123'); setEnv('CF_ANALYTICS_TOKEN', 'token123');
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/analytics_engine/sql');
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer token123');
      const q = String(init!.body);
      seen.push(q);
      let data: Record<string, unknown>[] = [];
      if (q.includes('AS day')) data = [{ day: '2026-10-11 00:00:00', visitors: '12', views: '40' }];
      else if (q.includes('GROUP BY name')) data = [{ name: 'popup_open', n: '30', people: '10' }, { name: 'save', n: '9', people: '4' }];
      else if (q.includes("blob1 = 'popup_open' AND blob3")) data = [{ k: 'denim-night', n: '7' }];
      else if (q.includes('blob1 = \'view\' AND double2 = 1 GROUP BY') || q.includes('GROUP BY k ORDER BY n DESC LIMIT 10') && q.includes('blob5')) data = [{ k: 'google.com', n: '5' }, { k: '', n: '3' }];
      else if (q.includes('INTERVAL \'14\' DAY') && !q.includes('<=')) data = [{ n: '14' }];
      else if (q.includes('<= NOW()')) data = [{ n: '10' }];
      else if (q.includes('uniq(index1) AS n')) data = [{ n: '8' }];
      return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
    });
    const r = await get('/admin/insights?days=7', boss);
    const e = r.json.events;
    expect(e.status).toBe('ok');
    expect(e.daily).toHaveLength(7);
    expect(e.daily.find((d: any) => d.day === '2026-10-11')).toMatchObject({ visitors: 12, views: 40 });
    expect(e.daily.find((d: any) => d.day === '2026-10-10')).toMatchObject({ visitors: 0, views: 0 });
    expect(e.funnel.popup_open).toEqual({ n: 30, people: 10 });
    expect(e.top_popups[0]).toMatchObject({ slug: 'denim-night', opens: 7 });
    // 8 this week + 10 last week - 14 across both = 4 visitors in both weeks
    expect(e.retention).toEqual({ last_week: 10, came_back: 4, rate: 0.4 });
    // every query reads the one dataset and only fixed text, never a value from the request
    expect(seen.every(q => q.includes('FROM spotted_events'))).toBe(true);
  });

  it('reads channels, sign-in reasons, how pop-ups were opened, the add funnel and empty results back', async () => {
    const boss = await user('in_boss6', 'admin');
    setEnv('CF_ACCOUNT_ID', 'acct123'); setEnv('CF_ANALYTICS_TOKEN', 'token123');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const q = String(init!.body);
      let data: Record<string, unknown>[] = [];
      if (q.includes('blob9 AS ch')) data = [
        { ch: 'instagram:social', name: 'view', people: '20' }, { ch: 'instagram:social', name: 'popup_open', people: '12' }, { ch: 'instagram:social', name: 'save', people: '5' }, { ch: 'instagram:social', name: 'signin_done', people: '2' },
        { ch: 'google:cpc', name: 'view', people: '30' }, { ch: '', name: 'view', people: '50' }, { ch: '', name: 'submit_done', people: '1' },
      ];
      else if (q.includes('blob10 AS k')) data = [{ k: 'autumn', n: '9' }];
      else if (q.includes('blob8 AS why')) data = [{ why: 'vote', name: 'gate_open', people: '10' }, { why: 'vote', name: 'signin_start', people: '6' }, { why: 'vote', name: 'signin_done', people: '3' }, { why: 'save', name: 'gate_open', people: '4' }];
      else if (q.includes("blob1 = 'popup_open' AND blob8")) data = [{ k: 'list', n: '40' }, { k: 'ask', n: '5' }];
      else if (q.includes("blob1 = 'autofill'")) data = [{ kind: 'link', ok: '1', n: '8' }, { kind: 'link', ok: '0', n: '2' }, { kind: 'image', ok: '1', n: '1' }];
      else if (q.includes("blob1 = 'submit_error'")) data = [{ k: 'where', n: '7' }, { k: 'title', n: '2' }];
      else if (q.includes('search_empty')) data = [{ event: 'search_empty', k: '', n: '6' }, { event: 'filter_empty', k: 'cat:food', n: '3' }];
      else if (q.includes('GROUP BY name')) data = [{ name: 'submit_start', n: '14', people: '9' }];
      return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
    });
    const e = (await get('/admin/insights?days=7&fresh=1', boss)).json.events;
    expect(e.status).toBe('ok');
    expect(e.channels[0]).toEqual({ key: '', visitors: 50, opened: 0, saved: 0, signed_in: 0, posted: 1 });
    expect(e.channels.find((c: any) => c.key === 'instagram:social')).toEqual({ key: 'instagram:social', visitors: 20, opened: 12, saved: 5, signed_in: 2, posted: 0 });
    expect(e.campaigns).toEqual([{ key: 'autumn', visits: 9 }]);
    expect(e.gate).toEqual([{ key: 'vote', seen: 10, started: 6, done: 3 }, { key: 'save', seen: 4, started: 0, done: 0 }]);
    expect(e.open_via).toEqual([{ key: 'list', n: 40 }, { key: 'ask', n: 5 }]);
    expect(e.add.started).toBe(9);
    expect(e.add.autofill).toEqual([{ kind: 'link', ok: 8, empty: 2 }, { kind: 'image', ok: 1, empty: 0 }]);
    expect(e.add.stuck[0]).toEqual({ key: 'where', n: 7 });
    expect(e.empty).toEqual([{ key: 'search', n: 6 }, { key: 'cat:food', n: 3 }]);
  });

  it('reports a failed read instead of breaking the page, and tries again next time', async () => {
    const boss = await user('in_boss5', 'admin');
    setEnv('CF_ACCOUNT_ID', 'acct123'); setEnv('CF_ANALYTICS_TOKEN', 'bad');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('no', { status: 403 }));
    const r = await get('/admin/insights', boss);
    expect(r.status).toBe(200);
    expect(r.json.events.status).toBe('error');
    expect(r.json.events.message).toContain('403');
    expect(r.json.accounts.total).toBeGreaterThan(0);
    const calls = spy.mock.calls.length;
    await get('/admin/insights', boss);
    expect(spy.mock.calls.length).toBeGreaterThan(calls); // the failure was not cached
  });
});
