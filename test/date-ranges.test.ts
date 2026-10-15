import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { listPopups } from '../src/routes/popups';
import { loadSnapshotItems } from '../src/db/snapshot';
import { filterPopups } from '../src/shared/filter-popups';
import { londonTime } from '../src/lib/time';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London (BST)
const day = (m: number, d: number) => londonTime(2026, m, d, 0, 0);
const endDay = (m: number, d: number) => londonTime(2026, m, d, 23, 59);

type Opts = { user?: string; body?: unknown; now?: number };
async function api(method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { 'x-now': String(o.now ?? NOW) };
  if (o.user) headers['x-dev-user'] = o.user;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
  return { status: res.status, json: (await res.json()) as any };
}
let n = 0;
async function user(role = 'user') {
  const id = `dr${++n}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare('INSERT INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, ?, 100, 10, 1, ?)')
    .bind(id, `${id}@test.dev`, id, role, NOW - 90 * DAY).run();
  return id;
}
const body = (over: Record<string, unknown> = {}) => ({
  title: 'Bank tours', category: 'event', host: 'The Bank', lat: 51.5142, lng: -0.0885, address: 'Threadneedle Street, EC2', borough: 'City',
  source_url: 'https://bank.test/tours', ...over,
});
// two separate days: 8 Oct and 5 Nov
const TWO = [[day(10, 8), endDay(10, 8)], [day(11, 5), endDay(11, 5)]];

describe('pop-ups with several date ranges', () => {
  it('stores the span in start_at and end_at and the ranges beside it', async () => {
    const r = await api('POST', '/popups', { user: await user(), body: body({ title: 'Span check tours', ranges: [TWO[1], TWO[0]] }) });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ start_at: TWO[0][0], end_at: TWO[1][1], ranges: TWO });
    expect(r.json.status).toBe('community');
    const row = await env.DB.prepare('SELECT start_at, end_at, date_ranges FROM popups WHERE id = ?').bind(r.json.id).first<any>();
    expect(JSON.parse(row.date_ranges)).toEqual(TWO);
  });

  it('one range after joining is an ordinary pop-up, and bad lists are refused', async () => {
    const u = await user();
    const one = await api('POST', '/popups', { user: u, body: body({ title: 'Joined into one run', lat: 51.52, ranges: [[day(10, 8), endDay(10, 9)], [day(10, 10), endDay(10, 11)]] }) });
    expect(one.status).toBe(201);
    expect(one.json.ranges).toBeUndefined();
    expect(one.json).toMatchObject({ start_at: day(10, 8), end_at: endDay(10, 11) });
    expect((await api('POST', '/popups', { user: u, body: body({ title: 'Bad range pair', lat: 51.53, ranges: [[5, 1], TWO[1]] }) })).json.error.code).toBe('dates_invalid');
    expect((await api('POST', '/popups', { user: u, body: body({ title: 'Not a list', lat: 51.54, ranges: 'x' }) })).json.error.code).toBe('ranges_invalid');
    const wide = [[day(10, 8), endDay(10, 8)], [day(10, 8) + 400 * DAY, endDay(10, 8) + 400 * DAY]];
    expect((await api('POST', '/popups', { user: u, body: body({ title: 'Too far apart', lat: 51.55, ranges: wide }) })).json.error.code).toBe('span_too_long');
    const many = Array.from({ length: 13 }, (_, i) => [day(10, 8) + i * 3 * DAY, day(10, 8) + i * 3 * DAY + 3_600_000]);
    expect((await api('POST', '/popups', { user: u, body: body({ title: 'Thirteen dates', lat: 51.56, ranges: many }) })).json.error.code).toBe('too_many_ranges');
    // all dates already over is refused like any ended pop-up
    expect((await api('POST', '/popups', { user: u, body: body({ title: 'All in the past', lat: 51.57, ranges: [[NOW - 9 * DAY, NOW - 8 * DAY], [NOW - 3 * DAY, NOW - 2 * DAY]] }) })).json.error.code).toBe('already_ended');
  });

  it('the list shows it only while a range falls in the window, and SQL and the browser filter agree', async () => {
    const u = await user();
    const created = (await api('POST', '/popups', { user: u, body: body({ title: 'Gap lister alpha', lat: 51.61, ranges: TWO }) })).json;
    const wk = (when: string, now: number) => api('GET', `/popups?when=${when}&q=gap%20lister`, { now });
    // Wed 30 Sep: nothing in the next 7 days, 8 Oct is 8 days away
    expect((await wk('week', NOW)).json.items).toHaveLength(0);
    // Mon 5 Oct: 8 Oct is in the next 7 days
    expect((await wk('week', day(10, 5))).json.items.map((i: any) => i.id)).toEqual([created.id]);
    // Tue 20 Oct: the first day has passed and the second is far off: in the gap, not in "week"
    expect((await wk('week', day(10, 20))).json.items).toHaveLength(0);
    expect((await wk('all', day(10, 20))).json.items.map((i: any) => i.id)).toEqual([created.id]);
    // The browser's filter on the snapshot gives the same answers
    for (const now of [NOW, day(10, 5), day(10, 8) + 3_600_000, day(10, 20), day(11, 2), day(11, 5) + 3_600_000]) {
      for (const when of ['today', 'weekend', 'week', 'all']) {
        const q = { when, q: 'gap lister', limit: '50' };
        const sql = (await listPopups(env.DB, q, now)).items.map(i => i.id);
        const items = (await loadSnapshotItems(env.DB, now)).filter(i => i.title.startsWith('Gap lister'));
        const browser = filterPopups(items as any, q, now).items.map((i: any) => i.id);
        expect(browser, `${when} at ${new Date(now).toISOString()}`).toEqual(sql);
      }
    }
  });

  it('hot ignores the gap: no "live now" lift between dates, a countdown to the next one', async () => {
    const { hot } = await import('../src/lib/scoring');
    const { hotSpan } = await import('../src/db/popups');
    const row = { start_at: TWO[0][0], end_at: TWO[1][1], date_ranges: JSON.stringify(TWO) };
    const base = { status: 'community' as const, qualityPos: 1, qualityNeg: 0 };
    const onDay = hot({ ...base, ...hotSpan(row, day(10, 8) + 3_600_000) }, day(10, 8) + 3_600_000);
    const inGap = hot({ ...base, ...hotSpan(row, day(10, 20)) }, day(10, 20));
    expect(onDay).toBeGreaterThan(inGap + 1);
    expect(inGap).toBeLessThan(hot({ ...base, startAt: row.start_at, endAt: row.end_at }, day(10, 20)) + 0.01); // the whole span would have said "live"
  });

  it('check-in works on a date, not in the gap', async () => {
    const poster = await user();
    const p = (await api('POST', '/popups', { user: poster, body: body({ title: 'Checkin gap tours', lat: 51.62, lng: -0.09, ranges: [[NOW - 2 * DAY, NOW - DAY], [NOW + 5 * DAY, NOW + 6 * DAY]] }) })).json;
    const there = { lat: 51.62, lng: -0.09 };
    expect((await api('POST', `/popups/${p.id}/checkin`, { user: await user(), body: there })).json.error.code).toBe('not_live');
    const onDate = await api('POST', `/popups/${p.id}/checkin`, { user: await user(), body: there, now: NOW + 5 * DAY + 3_600_000 });
    expect(onDate.status).toBe(200);
    expect(onDate.json.valid).toBe(true);
  });

  it('adding a date keeps the votes, changing one resets them, and an older client that sets start and end replaces the list', async () => {
    const poster = await user(), voter = await user();
    const p = (await api('POST', '/popups', { user: poster, body: body({ title: 'Edit ranges tours', lat: 51.63, ranges: undefined, start_at: TWO[0][0], end_at: TWO[0][1] }) })).json;
    await api('PUT', `/popups/${p.id}/vote`, { user: voter, body: { kind: 'existence', value: 1 } });
    const added = await api('PATCH', `/popups/${p.id}`, { user: poster, body: { ranges: TWO } });
    expect(added.json).toMatchObject({ votes_reset: false, ranges: TWO, end_at: TWO[1][1] });
    const changed = await api('PATCH', `/popups/${p.id}`, { user: poster, body: { ranges: [[day(10, 9), endDay(10, 9)], TWO[1]] } });
    expect(changed.json.votes_reset).toBe(true);
    const old = await api('PATCH', `/popups/${p.id}`, { user: poster, body: { start_at: day(10, 12), end_at: endDay(10, 13) } });
    expect(old.json.ranges).toBeUndefined();
    expect(old.json).toMatchObject({ start_at: day(10, 12), end_at: endDay(10, 13) });
    const cleared = await api('PATCH', `/popups/${p.id}`, { user: poster, body: { ranges: TWO } });
    expect(cleared.json.ranges).toEqual(TWO);
    expect((await api('PATCH', `/popups/${p.id}`, { user: poster, body: { ranges: null, start_at: day(10, 12), end_at: endDay(10, 12) } })).json.ranges).toBeUndefined();
  });

  it('duplicates look at the dates, not the span between them', async () => {
    const u = await user();
    const a = await api('POST', '/popups', { user: u, body: body({ title: 'Dup ranges tours', lat: 51.64, ranges: TWO }) });
    expect(a.status).toBe(201);
    // a post at the same place with a similar name, only in the gap
    const inGap = await api('POST', '/popups', { user: u, body: body({ title: 'Dup ranges tours', lat: 51.64, start_at: day(10, 20), end_at: endDay(10, 21) }) });
    expect(inGap.status).toBe(201);
    // one on the second date is a duplicate
    const onDate = await api('POST', '/popups', { user: u, body: body({ title: 'Dup ranges tours', lat: 51.64, start_at: day(11, 5), end_at: endDay(11, 5) }) });
    expect(onDate.json.error.code).toBe('possible_duplicate');
    expect(onDate.json.error.candidates[0].ranges).toEqual(TWO);
  });

  it('is public JSON only when there are two or more', async () => {
    const u = await user();
    const plain = (await api('POST', '/popups', { user: u, body: body({ title: 'Plain single run', lat: 51.65, start_at: day(10, 8), end_at: endDay(10, 9) }) })).json;
    expect('ranges' in plain).toBe(false);
    const items = await loadSnapshotItems(env.DB, NOW);
    expect(items.find(i => i.id === plain.id) && 'ranges' in items.find(i => i.id === plain.id)!).toBe(false);
  });
});
