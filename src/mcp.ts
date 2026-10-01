// MCP server (Streamable HTTP, stateless, JSON responses) at POST /mcp.
//
// Anyone's AI assistant can search and read public pop-ups without a key. Spotted's own agents
// on Manyfold send `Authorization: Bearer spk_...` and get the extra tools for their job
// (AGENT_INFO in src/db/agents.ts). Agents can write drafts and notes only: drafts are always
// pending, and nothing here approves, removes or votes.
//
// Hand-written JSON-RPC rather than the MCP SDK: four methods, no sessions, and it keeps the
// Worker small and fast on the free plan.

import { Hono, type Context } from 'hono';
import type { AppEnv, PopupRow } from './types';
import { AGENT_INFO, agentByKey, type AgentRow, type RunRow } from './db/agents';
import { findDuplicates, listPopups, parsePopupInput } from './routes/popups';
import { searchPlaces, type WaitUntil } from './routes/geocode';
import { toPublic } from './db/popups';
import { CATEGORIES, safeUrl } from './lib/extract';
import { geohash } from './lib/geo';
import { DAY, hot, PUBLIC_STATUSES } from './lib/scoring';
import { londonDateString, parseLondonDate } from './lib/time';
import { ApiError, newId, slugify } from './lib/util';

export const mcp = new Hono<AppEnv>();

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERDICTS = ['looks_real', 'needs_check', 'likely_fake', 'duplicate', 'details_changed', 'cancelled'] as const;

type Args = Record<string, unknown>;
interface Ctx { c: Context<AppEnv>; agent: AgentRow | null; now: number; origin: string }
interface Tool { description: string; inputSchema: Record<string, unknown>; run: (a: Args, x: Ctx) => Promise<unknown> }

/** Error the model can read and act on; returned as a tool result with isError. */
class ToolError extends Error {}

const str = (a: Args, k: string, max: number, required = false): string | null => {
  const v = a[k];
  if (v === undefined || v === null || v === '') { if (required) throw new ToolError(`${k} is required.`); return null; }
  if (typeof v !== 'string') throw new ToolError(`${k} must be a string.`);
  return v.trim().slice(0, max) || null;
};
const numArg = (a: Args, k: string): number | null => {
  const v = a[k];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${k} must be a number.`);
  return n;
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const N = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'number', description, ...extra });
const RUN_ID = S('The run id from your brief.');

/** Compact, model-friendly view of a pop-up. */
function brief(p: ReturnType<typeof toPublic>, origin: string) {
  return {
    id: p.id,
    title: p.title,
    url: `${origin}/p/${p.slug}`,
    category: p.category,
    host: p.host,
    dates: `${londonDateString(p.start_at)} to ${londonDateString(p.end_at)}`,
    hours: p.hours_text,
    address: p.location.address,
    area: p.location.borough,
    lat: p.location.lat,
    lng: p.location.lng,
    price: p.price.text ?? p.price.type,
    status: p.status === 'verified_admin' || p.status === 'verified_community' ? 'verified' : p.status === 'community' ? 'unverified, open for votes' : p.status,
    ...(p.example ? { example: 'Fictional example listing, not a real event' } : {}),
    ...('distance_m' in p ? { distance_m: (p as { distance_m?: number }).distance_m } : {}),
  };
}

async function requireRun(x: Ctx, a: Args): Promise<RunRow> {
  const runId = str(a, 'run_id', 40, true)!;
  const run = await x.c.env.DB.prepare('SELECT * FROM agent_runs WHERE id = ? AND agent_id = ?').bind(runId, x.agent!.id).first<RunRow>();
  if (!run) throw new ToolError('Unknown run_id. Use the run id from your brief.');
  if (run.status !== 'running') throw new ToolError('This run is already finished. Nothing more can be written for it.');
  return run;
}

/** Counts one written item against the run's limit. */
async function useItem(x: Ctx, run: RunRow) {
  const r = await x.c.env.DB.prepare('UPDATE agent_runs SET items = items + 1 WHERE id = ? AND items < ?').bind(run.id, x.agent!.max_items).run();
  if (!r.meta.changes) throw new ToolError(`You reached this run's limit of ${x.agent!.max_items}. Call finish_run now.`);
}

function dates(a: Args) {
  const start = str(a, 'start_date', 10, true)!, end = str(a, 'end_date', 10, true)!;
  const start_at = parseLondonDate(start, 0, 0), endDay = parseLondonDate(end, 23, 59);
  if (start_at === null || endDay === null) throw new ToolError('Dates must look like 2026-10-03.');
  return { start_at, end_at: endDay };
}

const TOOLS: Record<string, Tool> = {
  search_popups: {
    description: 'Search pop-ups in London listed on Spotted London: food, fashion, samples, art, markets, beauty and tech. Returns up to 20, soonest and most popular first, each with a link.',
    inputSchema: obj({
      when: S('Time window, London time. Defaults to week.', { enum: ['today', 'weekend', 'week', 'all'] }),
      category: S('Only this category.', { enum: [...CATEGORIES] }),
      query: S('Words to match in the title, host or area, like "matcha" or "Shoreditch".'),
      near_lat: N('Latitude to search around. Use with near_lng.'),
      near_lng: N('Longitude to search around. Use with near_lat.'),
      radius_km: N('Search radius around near_lat/near_lng, 0.1 to 20. Defaults to 2.'),
      free_only: { type: 'boolean', description: 'Only free entry.' },
      verified_only: { type: 'boolean', description: 'Only pop-ups the community or an admin confirmed are real.' },
      limit: N('How many to return, 1 to 20. Defaults to 10.'),
    }),
    async run(a, x) {
      const q: Record<string, string> = { when: str(a, 'when', 10) ?? 'week', limit: String(Math.min(20, Math.max(1, numArg(a, 'limit') ?? 10))) };
      const cat = str(a, 'category', 20); if (cat) q.category = cat;
      const text = str(a, 'query', 80); if (text) q.q = text;
      const lat = numArg(a, 'near_lat'), lng = numArg(a, 'near_lng');
      if (lat !== null && lng !== null) { q.near = `${lat},${lng}`; q.sort = 'distance'; const r = numArg(a, 'radius_km'); if (r) q.radius_km = String(r); }
      if (a.free_only === true) q.free = '1';
      if (a.verified_only === true) q.verified = '1';
      const out = await listPopups(x.c.env.DB, q, x.now, null);
      return { count: out.items.length, popups: out.items.map(p => brief(p, x.origin)) };
    },
  },
  get_popup: {
    description: 'Full details of one pop-up on Spotted London, by its id or the slug from its link.',
    inputSchema: obj({ id: S('Pop-up id, or the slug at the end of a spotted link (/p/<slug>).') }, ['id']),
    async run(a, x) {
      const id = str(a, 'id', 120, true)!.replace(/^.*\/p\//, '');
      const p = await x.c.env.DB.prepare('SELECT * FROM popups WHERE id = ?1 OR slug = ?1').bind(id).first<PopupRow>();
      // Agents also see pending posts, so triage can read what it is judging.
      const visible = p && (PUBLIC_STATUSES.includes(p.status) || p.status === 'ended' || (x.agent && p.status === 'pending'));
      if (!visible) throw new ToolError('No pop-up with that id or slug.');
      return { ...brief(toPublic(p), x.origin), description: p.description, source_url: p.source_url, confirmations: { weighted_votes: p.exist_pos + p.exist_neg, checkins: p.checkin_count } };
    },
  },

  /* ---------- agent tools ---------- */
  find_place: {
    description: 'Look up a London address or venue name and get coordinates. Use the result for submit_draft.',
    inputSchema: obj({ query: S('Venue name and/or address, like "Coal Drops Yard" or "12 Redchurch Street E2".') }, ['query']),
    async run(a, x) {
      let ctx: WaitUntil | undefined;
      try { ctx = x.c.executionCtx; } catch { ctx = undefined; }
      const places = await searchPlaces(str(a, 'query', 120, true)!, ctx);
      return { places: places.map(p => ({ label: p.label, address: p.address, area: p.area, lat: p.lat, lng: p.lng })) };
    },
  },
  check_duplicates: {
    description: 'Check whether a pop-up is already on Spotted (same place, overlapping dates, similar title) before sending it.',
    inputSchema: obj({ title: S('Pop-up title.'), lat: N('Latitude.'), lng: N('Longitude.'), start_date: S('First day, YYYY-MM-DD.'), end_date: S('Last day, YYYY-MM-DD.') }, ['title', 'lat', 'lng', 'start_date', 'end_date']),
    async run(a, x) {
      const lat = numArg(a, 'lat'), lng = numArg(a, 'lng');
      if (lat === null || lng === null) throw new ToolError('lat and lng are required.');
      const found = await findDuplicates(x.c.env.DB, { title: str(a, 'title', 100, true)!, lat, lng, ...dates(a) });
      return { duplicates: found.map(p => brief(toPublic(p), x.origin)) };
    },
  },
  submit_draft: {
    description: 'Send a pop-up you found as a draft. It goes to the review queue and is only published if the admin approves it. Needs a source link where you saw it.',
    inputSchema: obj({
      run_id: RUN_ID,
      title: S('Name of the pop-up, as the organiser writes it. 3 to 100 characters.'),
      category: S('Best fitting category.', { enum: [...CATEGORIES] }),
      start_date: S('The real first day, YYYY-MM-DD, London. Give it even if it is in the past for a pop-up that is still running.'),
      end_date: S('Last day, YYYY-MM-DD, London. Same as start_date for one-day events. Must not have passed.'),
      lat: N('Latitude from find_place.'),
      lng: N('Longitude from find_place.'),
      address: S('Street address.'),
      area: S('Neighbourhood or borough, like "Shoreditch".'),
      host: S('Brand or organiser.'),
      description: S('Two or three plain sentences: what it is and why people go. No hype.'),
      hours_text: S('Opening hours, like "Fri 5-10pm, Sat-Sun 12-8pm".'),
      price_type: S('Entry price.', { enum: ['free', 'paid', 'unknown'] }),
      price_text: S('Price details, like "Free entry" or "£12 tickets".'),
      source_url: S('Public link where the details are published: the organiser page, ticket page or article.'),
      confidence: S('high: dates and place confirmed by the organiser. check: something is unclear.', { enum: ['high', 'check'] }),
      note_for_admin: S('What you checked and anything unclear, in one or two sentences.'),
    }, ['run_id', 'title', 'category', 'start_date', 'end_date', 'lat', 'lng', 'address', 'source_url']),
    async run(a, x) {
      const run = await requireRun(x, a);
      const db = x.c.env.DB;
      const source = str(a, 'source_url', 500, true)!;
      if (!safeUrl(source)) throw new ToolError('source_url must be a public web address.');
      let input: ReturnType<typeof parsePopupInput>;
      try {
        input = parsePopupInput({ ...a, borough: a.area, ...dates(a) }, x.now, true, { ongoing: true });
      } catch (e) {
        throw new ToolError(e instanceof ApiError ? e.message : String(e));
      }
      const dupes = await findDuplicates(db, input as { title: string; lat: number; lng: number; start_at: number; end_at: number });
      if (dupes.length) {
        return { sent: false, reason: 'Already on Spotted. Skip it.', duplicates: dupes.map(p => brief(toPublic(p), x.origin)) };
      }
      await useItem(x, run);
      const id = newId();
      const row = {
        id, slug: slugify(input.title!), ...input, geohash: geohash(input.lat!, input.lng!), status: 'pending',
        created_by: x.agent!.user_id, quality_pos: 0, quality_neg: 0, created_at: x.now, updated_at: x.now,
        hot: hot({ status: 'pending', qualityPos: 0, qualityNeg: 0, startAt: input.start_at!, endAt: input.end_at! }, x.now),
      };
      const cols = Object.keys(row);
      const note = str(a, 'note_for_admin', 600);
      await db.batch([
        db.prepare(`INSERT INTO popups (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(k => (row as Record<string, unknown>)[k] ?? null)),
        db.prepare('INSERT INTO agent_notes (id, agent_id, run_id, popup_id, verdict, note, evidence_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(newId(), x.agent!.id, run.id, id, a.confidence === 'high' ? 'looks_real' : 'needs_check', note ?? 'Found by the scout agent.', input.source_url, x.now),
      ]);
      return { sent: true, id, status: 'pending', message: 'Draft saved. It is waiting for the admin.' };
    },
  },
  list_review_queue: {
    description: 'Posts waiting for review that you have not left a note on yet, oldest first.',
    inputSchema: obj({ limit: N('1 to 30. Defaults to 15.') }),
    async run(a, x) {
      const limit = Math.min(30, Math.max(1, numArg(a, 'limit') ?? 15));
      const { results } = await x.c.env.DB.prepare(
        `SELECT p.*, u.display_name AS poster_name, u.karma AS poster_karma, u.created_at AS poster_created_at FROM popups p JOIN users u ON u.id = p.created_by
         WHERE p.status = 'pending' AND p.end_at > ? AND NOT EXISTS (SELECT 1 FROM agent_notes n WHERE n.popup_id = p.id AND n.agent_id = ?)
         ORDER BY p.created_at LIMIT ?`,
      ).bind(x.now, x.agent!.id, limit).all<PopupRow & { poster_name: string | null; poster_karma: number; poster_created_at: number }>();
      return {
        count: results.length,
        posts: results.map(p => ({
          ...brief(toPublic(p), x.origin), description: p.description, source_url: p.source_url,
          poster: { name: p.poster_name, karma: p.poster_karma, account_age_days: Math.floor((x.now - p.poster_created_at) / DAY), is_agent: p.created_by.startsWith('agent_') },
        })),
      };
    },
  },
  list_live_popups: {
    description: 'Published pop-ups that are on now or coming up and have a source link, starting with the ones checked least recently. Skips any you checked in the last 3 days.',
    inputSchema: obj({ limit: N('1 to 30. Defaults to 15.') }),
    async run(a, x) {
      const limit = Math.min(30, Math.max(1, numArg(a, 'limit') ?? 15));
      const { results } = await x.c.env.DB.prepare(
        `SELECT p.* FROM popups p WHERE p.status IN ('community', 'verified_community', 'verified_admin') AND p.end_at > ? AND p.source_url IS NOT NULL AND p.is_example = 0
           AND NOT EXISTS (SELECT 1 FROM agent_notes n WHERE n.popup_id = p.id AND n.agent_id = ? AND n.created_at > ?)
         ORDER BY p.start_at LIMIT ?`,
      ).bind(x.now, x.agent!.id, x.now - 3 * DAY, limit).all<PopupRow>();
      return { count: results.length, popups: results.map(p => ({ ...brief(toPublic(p), x.origin), source_url: p.source_url })) };
    },
  },
  add_note: {
    description: 'Leave the admin a note on a pop-up. looks_real and needs_check are for posts waiting for review; details_changed, cancelled and likely_fake flag a published pop-up for the admin. On published pop-ups, use looks_real to record that you checked and all is fine.',
    inputSchema: obj({
      run_id: RUN_ID,
      popup_id: S('Pop-up id.'),
      verdict: S('Your finding.', { enum: [...VERDICTS] }),
      note: S('One to three sentences: what you checked and what you found. Say exactly what changed, if anything.'),
      evidence_url: S('Link that shows it.'),
      duplicate_of: S('For verdict duplicate: id of the pop-up it repeats.'),
    }, ['run_id', 'popup_id', 'verdict', 'note']),
    async run(a, x) {
      const run = await requireRun(x, a);
      const db = x.c.env.DB;
      const verdict = str(a, 'verdict', 20, true)!;
      if (!(VERDICTS as readonly string[]).includes(verdict)) throw new ToolError(`verdict must be one of: ${VERDICTS.join(', ')}.`);
      const popupId = str(a, 'popup_id', 40, true)!;
      const p = await db.prepare('SELECT id, status FROM popups WHERE id = ?').bind(popupId).first<{ id: string; status: string }>();
      if (!p) throw new ToolError('No pop-up with that id.');
      const dup = str(a, 'duplicate_of', 40);
      if (verdict === 'duplicate' && !dup) throw new ToolError('Give duplicate_of for verdict duplicate.');
      if (dup && !(await db.prepare('SELECT 1 FROM popups WHERE id = ?').bind(dup).first())) throw new ToolError('duplicate_of is not a pop-up id.');
      const evidence = str(a, 'evidence_url', 500);
      if (evidence && !safeUrl(evidence)) throw new ToolError('evidence_url must be a public web address.');
      const existing = await db.prepare('SELECT id FROM agent_notes WHERE run_id = ? AND popup_id = ?').bind(run.id, p.id).first();
      if (!existing) await useItem(x, run);
      await db.prepare(
        `INSERT INTO agent_notes (id, agent_id, run_id, popup_id, verdict, note, evidence_url, duplicate_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, popup_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, evidence_url = excluded.evidence_url, duplicate_of = excluded.duplicate_of`,
      ).bind(newId(), x.agent!.id, run.id, p.id, verdict, str(a, 'note', 600, true), evidence ? safeUrl(evidence)!.toString() : null, dup, x.now).run();
      return { saved: true };
    },
  },
  finish_run: {
    description: 'End your run with a short summary for the admin. Call this once, last.',
    inputSchema: obj({ run_id: RUN_ID, summary: S('What you looked at, what you sent or flagged, and anything the admin should know. Under 150 words.') }, ['run_id', 'summary']),
    async run(a, x) {
      const run = await requireRun(x, a);
      await x.c.env.DB.prepare("UPDATE agent_runs SET status = 'done', summary = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .bind(str(a, 'summary', 2000, true), x.now, run.id).run();
      return { finished: true };
    },
  },
};

const PUBLIC_TOOLS = ['search_popups', 'get_popup'];
const toolsFor = (agent: AgentRow | null) => [...PUBLIC_TOOLS, ...(agent ? AGENT_INFO[agent.id].tools : [])];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg: Rpc, x: Ctx): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid request.');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'spotted-london', title: 'Spotted London', version: '1.0.0' },
        instructions: x.agent
          ? `You are signed in as the ${AGENT_INFO[x.agent.id].name} agent. Follow the spotted-london skill.`
          : 'Spotted London lists pop-ups in London that the community verifies. Search, then share the url of each pop-up so people can see details, votes and the map.',
      });
    }
    case 'ping': return isNotification ? null : reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: toolsFor(x.agent).map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema })) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!TOOLS[name]) return fail(msg.id, -32602, `Unknown tool: ${name}.`);
      if (!toolsFor(x.agent).includes(name)) {
        return reply(msg.id, { isError: true, content: [{ type: 'text', text: x.agent ? `The ${AGENT_INFO[x.agent.id].name} agent cannot use ${name}.` : `${name} needs an agent key.` }] });
      }
      const args = (msg.params?.arguments ?? {}) as Args;
      try {
        const out = await TOOLS[name].run(typeof args === 'object' && args ? args : {}, x);
        return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        if (e instanceof ToolError || e instanceof ApiError) return reply(msg.id, { isError: true, content: [{ type: 'text', text: e.message }] });
        console.error('mcp tool failed', name, e);
        return reply(msg.id, { isError: true, content: [{ type: 'text', text: 'The tool failed on our side. Try again later.' }] });
      }
    }
    default:
      if (isNotification) return null;
      return fail(msg.id, -32601, `Method not found: ${msg.method}.`);
  }
}

mcp.post('/', async c => {
  const auth = c.req.header('authorization') ?? '';
  let agent: AgentRow | null = null;
  if (auth) {
    agent = await agentByKey(c.env.DB, auth.replace(/^Bearer\s+/i, '').trim());
    if (!agent) return c.json(fail(null, -32001, 'This key is not valid. Create a new key on Spotted under Admin, Agents.'), 401);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(fail(null, -32700, 'The request body must be JSON.'), 400); }
  const url = new URL(c.req.url);
  const x: Ctx = { c, agent, now: c.get('now'), origin: c.env.APP_URL ? new URL(c.env.APP_URL).origin : url.origin };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handle(m as Rpc, x)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(body as Rpc, x);
  return out ? c.json(out) : c.body(null, 202);
});

// No server-to-client stream and no sessions: GET and DELETE are not offered (MCP spec allows 405).
mcp.on(['GET', 'DELETE'], '/', c => c.body(null, 405, { allow: 'POST' }));
