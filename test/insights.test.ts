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
