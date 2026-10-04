import { beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { loadSnapshotItems } from '../src/db/snapshot';

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 13);

async function get(path: string) {
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { headers: { 'x-now': String(NOW) } }));
  return { status: res.status, body: await res.json() as any };
}

// ready: a Triage note with publish_ready. flagged: ready, then an open needs_check. plain: no note.
const IDS = { ready: 'sc_ready', flagged: 'sc_flagged', resolved: 'sc_resolved', plain: 'sc_plain', notReady: 'sc_notready' };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('sc_user', 'sc_user@test.dev', 'Poster', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY).run();
  await env.DB.prepare("INSERT INTO agent_runs (id, agent_id, trigger, status, started_at) VALUES ('sc_run', 'triage', 'manual', 'done', ?), ('sc_run2', 'checker', 'manual', 'done', ?)").bind(NOW, NOW).run();
  const stmts: D1PreparedStatement[] = [];
  Object.values(IDS).forEach((id, i) => stmts.push(env.DB.prepare(
    `INSERT INTO popups (id, slug, title, category, price_type, lat, lng, geohash, start_at, end_at, status, created_by, created_at, updated_at, hot, is_example)
     VALUES (?, ?, ?, 'art', 'free', ?, -0.1, 'gcpvj', ?, ?, 'community', 'sc_user', ?, ?, 0, 0)`,
  ).bind(id, id.replace('_', '-'), `Source check ${id}`, 51.5 + i * 0.01, NOW - HOUR, NOW + 48 * HOUR, NOW, NOW)));
  const note = (id: string, run: string, agent: string, popup: string, verdict: string, ready: number, resolved: number | null) =>
    env.DB.prepare('INSERT INTO agent_notes (id, agent_id, run_id, popup_id, verdict, note, publish_ready, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, agent, run, popup, verdict, 'n', ready, resolved, NOW);
  stmts.push(
    note('scn1', 'sc_run', 'triage', IDS.ready, 'looks_real', 1, null),
    note('scn2', 'sc_run', 'triage', IDS.flagged, 'looks_real', 1, null),
    note('scn3', 'sc_run2', 'checker', IDS.flagged, 'details_changed', 0, null),
    note('scn4', 'sc_run', 'triage', IDS.resolved, 'looks_real', 1, null),
    note('scn5', 'sc_run2', 'checker', IDS.resolved, 'details_changed', 0, NOW),
    note('scn6', 'sc_run', 'triage', IDS.notReady, 'looks_real', 0, null),
  );
  await env.DB.batch(stmts);
});

describe('source_checked', () => {
  const expected: Record<string, boolean> = { [IDS.ready]: true, [IDS.flagged]: false, [IDS.resolved]: true, [IDS.plain]: false, [IDS.notReady]: false };

  it('is in the snapshot: true only for a ready Triage note with no open flag', async () => {
    const items = await loadSnapshotItems(env.DB, NOW);
    for (const [id, want] of Object.entries(expected)) expect(items.find(p => p.id === id)?.source_checked, id).toBe(want);
  });

  it('is in the list and the detail, and never changes the status', async () => {
    const list = await get('/popups?when=all&limit=50');
    const detail = await get(`/popups/${IDS.ready}`);
    expect(list.status).toBe(200);
    for (const [id, want] of Object.entries(expected)) expect(list.body.items.find((p: any) => p.id === id)?.source_checked, id).toBe(want);
    expect(detail.body).toMatchObject({ status: 'community', source_checked: true });
    expect((await get(`/popups/${IDS.plain}`)).body).toMatchObject({ status: 'community', source_checked: false });
  });
});
