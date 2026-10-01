import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { purgeSocial, runSocial, SOCIAL_MONTHLY_BUDGET_USD } from '../src/db/social';
import { reserveUsd } from '../src/lib/social';

const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London (BST)

let n = 0;

/** A fake Apify. It records every call and checks the token never leaves the header. */
function fakeApify(o: { status?: string; items?: unknown[]; usage?: number; startFails?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    expect(url.search).not.toContain('token');
    if (method === 'POST' && /\/acts\/[^/]+\/runs$/.test(url.pathname)) {
      if (o.startFails) return new Response('{}', { status: 500 });
      return Response.json({ data: { id: 'apify-run-1', status: 'READY', defaultDatasetId: 'ds1', usageTotalUsd: 0 } }, { status: 201 });
    }
    if (method === 'POST' && url.pathname.endsWith('/abort')) return Response.json({ data: {} });
    if (method === 'GET' && url.pathname.startsWith('/v2/actor-runs/')) {
      return Response.json({ data: { id: 'apify-run-1', status: o.status ?? 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: o.usage ?? 0 } });
    }
    if (url.pathname.startsWith('/v2/datasets/')) return Response.json(o.items ?? []);
    throw new Error(`unexpected Apify call ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { f, calls };
}

const deps = (f: typeof fetch) => ({ db: env.DB, token: 'tok', fetch: f });

async function addSource(target: string, over: { kind?: string; every_days?: number; status?: string } = {}) {
  const id = `tsrc${++n}`;
  await env.DB.prepare('INSERT INTO scout_sources (id, kind, target, label, status, every_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, over.kind ?? 'social', target, `Test ${id}`, over.status ?? 'active', over.every_days ?? 2, NOW - DAY, NOW - DAY).run();
  return id;
}

const runsOf = async (id: string) =>
  (await env.DB.prepare('SELECT * FROM social_runs WHERE source_id = ? ORDER BY started_at').bind(id).all<any>()).results;
const postsOf = async (id: string) =>
  (await env.DB.prepare('SELECT * FROM social_posts WHERE source_id = ?').bind(id).all<any>()).results;

const igPost = (shortCode: string, caption: string, over: Record<string, unknown> = {}) => ({
  url: `https://www.instagram.com/p/${shortCode}/`, caption, ownerUsername: 'brand',
  timestamp: new Date(NOW - DAY).toISOString(), displayUrl: 'https://cdn.test/a.jpg', ...over,
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM social_posts'),
    env.DB.prepare('DELETE FROM social_runs'),
    env.DB.prepare('DELETE FROM scout_seen'),
    env.DB.prepare("DELETE FROM scout_sources WHERE id LIKE 'tsrc%'"),
  ]);
});

describe('social fetcher', () => {
  it('does nothing without a token', async () => {
    await addSource('https://www.instagram.com/explore/tags/londonpopup');
    const { f, calls } = fakeApify();
    await runSocial({ db: env.DB, fetch: f }, NOW);
    expect(calls).toEqual([]);
  });

  it('skips addresses it cannot fetch', async () => {
    const id = await addSource('https://www.tiktok.com/@brand');
    const { f, calls } = fakeApify();
    await runSocial(deps(f), NOW);
    expect(calls).toEqual([]);
    expect(await runsOf(id)).toEqual([]);
  });

  it('starts a run for a due source and holds its worst-case cost', async () => {
    const id = await addSource('https://www.instagram.com/explore/tags/londonpopup');
    const { f, calls } = fakeApify();
    await runSocial(deps(f), NOW);
    expect(calls).toEqual(['POST /v2/acts/apify~instagram-scraper/runs']);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'running', apify_run_id: 'apify-run-1', started_at: NOW });
    expect(run.cost_usd).toBeCloseTo(reserveUsd('instagram'));
    const src = await env.DB.prepare('SELECT due_at, last_checked_at FROM scout_sources WHERE id = ?').bind(id).first<any>();
    expect(src).toEqual({ due_at: null, last_checked_at: null }); // Scout's clock is untouched
  });

  it('does not start a second run while one is open or before the source is due again', async () => {
    const id = await addSource('https://www.instagram.com/coaldropsyard', { every_days: 2 });
    const first = fakeApify();
    await runSocial(deps(first.f), NOW);
    const second = fakeApify({ status: 'RUNNING' });
    await runSocial(deps(second.f), NOW + 10 * MIN);
    expect(second.calls).toEqual(['GET /v2/actor-runs/apify-run-1']);
    const done = fakeApify({ items: [] });
    await runSocial(deps(done.f), NOW + 20 * MIN);
    await runSocial(deps(fakeApify().f), NOW + 1 * DAY);
    expect((await runsOf(id)).length).toBe(1);
    const again = fakeApify();
    await runSocial(deps(again.f), NOW + 2 * DAY + MIN);
    expect(again.calls).toEqual(['POST /v2/acts/apify~instagram-scraper/runs']);
  });

  it('uses the Threads actor and input for Threads sources', async () => {
    await addSource('https://www.threads.net/search?q=london%20pop-up');
    const bodies: string[] = [];
    const inner = fakeApify();
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => { if (init?.body) bodies.push(String(init.body)); return inner.f(input, init); }) as typeof fetch;
    await runSocial(deps(f), NOW);
    expect(inner.calls).toEqual(['POST /v2/acts/themineworks~threads-scraper/runs']);
    expect(JSON.parse(bodies[0])).toEqual({ mode: 'search', searchQuery: 'london pop-up', maxPosts: 20 });
  });

  it('stores only new posts that pass the filter, and records the run', async () => {
    const id = await addSource('https://www.instagram.com/explore/tags/londonpopup');
    await env.DB.prepare("INSERT INTO scout_seen (id, url, outcome, seen_at) VALUES ('seen1', 'https://www.instagram.com/p/DDD', 'not_popup', ?)").bind(NOW - DAY).run();
    await runSocial(deps(fakeApify().f), NOW);
    const items = [
      igPost('AAA', 'Jacquemus pop-up at Coal Drops Yard this weekend'),
      igPost('BBB', 'Good morning London'),
      igPost('CCC', 'Old pop-up', { timestamp: new Date(NOW - 20 * DAY).toISOString() }),
      igPost('DDD', 'Sample sale in London'),
      { caption: 'no address' },
    ];
    await runSocial(deps(fakeApify({ items, usage: 0.01 }).f), NOW + 10 * MIN);
    const posts = await postsOf(id);
    expect(posts.map(p => p.url)).toEqual(['https://www.instagram.com/p/AAA']);
    expect(posts[0]).toMatchObject({ platform: 'instagram', author: 'brand', handled_at: null, fetched_at: NOW + 10 * MIN, run_id: (await runsOf(id))[0].id });
    expect(JSON.parse(posts[0].image_urls)).toEqual(['https://cdn.test/a.jpg']);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'done', items: 5, kept: 1, finished_at: NOW + 10 * MIN });
    expect(run.cost_usd).toBeCloseTo(0.0135); // 5 items at US$2.70 per 1,000 beats the reported 0.01
  });

  it('does not store the same post twice across runs', async () => {
    const id = await addSource('https://www.instagram.com/explore/tags/londonpopup', { every_days: 1 });
    const items = [igPost('AAA', 'Pop-up opening soon')];
    await runSocial(deps(fakeApify().f), NOW);
    await runSocial(deps(fakeApify({ items }).f), NOW + 10 * MIN);
    await runSocial(deps(fakeApify().f), NOW + 2 * DAY);
    await runSocial(deps(fakeApify({ items }).f), NOW + 2 * DAY + 10 * MIN);
    expect(await postsOf(id)).toHaveLength(1);
    expect((await runsOf(id)).map(r => r.status)).toEqual(['done', 'done']);
  });

  it('fails a run whose posts are in a shape it does not recognise', async () => {
    const id = await addSource('https://www.instagram.com/coaldropsyard');
    await runSocial(deps(fakeApify().f), NOW);
    await runSocial(deps(fakeApify({ items: [{ nope: 1 }, { nada: 2 }] }).f), NOW + 10 * MIN);
    const [run] = await runsOf(id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/shape we do not recognise/);
    expect(await postsOf(id)).toEqual([]);
  });

  it('fails a run Apify reports as failed and keeps its reported cost', async () => {
    const id = await addSource('https://www.instagram.com/coaldropsyard');
    await runSocial(deps(fakeApify().f), NOW);
    await runSocial(deps(fakeApify({ status: 'FAILED', usage: 0.02 }).f), NOW + 10 * MIN);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'failed', cost_usd: 0.02 });
    expect(run.error).toMatch(/failed/);
  });

  it('stops a run that takes longer than 30 minutes', async () => {
    const id = await addSource('https://www.instagram.com/coaldropsyard');
    await runSocial(deps(fakeApify().f), NOW);
    const late = fakeApify({ status: 'RUNNING' });
    await runSocial(deps(late.f), NOW + 31 * MIN);
    expect(late.calls).toContain('POST /v2/actor-runs/apify-run-1/abort');
    const [run] = await runsOf(id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/30 minutes/);
  });

  it('retries a failed source after 6 hours and pauses it after three failures in a row', async () => {
    const id = await addSource('https://www.instagram.com/coaldropsyard');
    const status = async () => (await env.DB.prepare('SELECT status, note FROM scout_sources WHERE id = ?').bind(id).first<any>());
    await runSocial(deps(fakeApify({ startFails: true }).f), NOW);
    const tooSoon = fakeApify();
    await runSocial(deps(tooSoon.f), NOW + 5 * HOUR);
    expect(tooSoon.calls).toEqual([]);
    await runSocial(deps(fakeApify({ startFails: true }).f), NOW + 7 * HOUR);
    expect((await status()).status).toBe('active');
    await runSocial(deps(fakeApify({ startFails: true }).f), NOW + 14 * HOUR);
    const after = await status();
    expect(after.status).toBe('paused');
    expect(after.note).toMatch(/Paused after 3 failed fetches in a row/);
    expect((await runsOf(id)).map(r => r.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('stays under the monthly budget and says so once a day', async () => {
    const other = await addSource('https://www.instagram.com/spender');
    await env.DB.prepare("INSERT INTO social_runs (id, source_id, status, cost_usd, started_at) VALUES ('sr_spent', ?, 'done', ?, ?)").bind(other, SOCIAL_MONTHLY_BUDGET_USD - 0.01, NOW - HOUR).run();
    const id = await addSource('https://www.instagram.com/explore/tags/londonpopup');
    const { f, calls } = fakeApify();
    await runSocial(deps(f), NOW);
    await runSocial(deps(f), NOW + 10 * MIN);
    expect(calls).toEqual([]);
    expect((await runsOf(id)).map(r => r.status)).toEqual(['skipped_budget']);
  });

  it('starts at most three runs per tick, oldest first', async () => {
    for (let i = 0; i < 5; i++) await addSource(`https://www.instagram.com/account${i}`);
    const { f, calls } = fakeApify();
    await runSocial(deps(f), NOW);
    expect(calls).toHaveLength(3);
  });

  it('removes posts and runs older than 90 days', async () => {
    const id = await addSource('https://www.instagram.com/coaldropsyard');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO social_runs (id, source_id, status, started_at) VALUES ('sr_old', ?, 'done', ?)").bind(id, NOW - 91 * DAY),
      env.DB.prepare("INSERT INTO social_posts (id, url, platform, source_id, run_id, fetched_at) VALUES ('sp_old', 'https://www.instagram.com/p/OLD', 'instagram', ?, 'sr_old', ?)").bind(id, NOW - 91 * DAY),
      env.DB.prepare("INSERT INTO social_posts (id, url, platform, source_id, fetched_at) VALUES ('sp_new', 'https://www.instagram.com/p/NEW', 'instagram', ?, ?)").bind(id, NOW - 10 * DAY),
    ]);
    await purgeSocial(env.DB, NOW);
    expect((await postsOf(id)).map(p => p.id)).toEqual(['sp_new']);
    expect(await runsOf(id)).toEqual([]);
  });
});
