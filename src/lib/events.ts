// Anonymous usage events (POST /api/v1/e). Pure: checks what the browser sent and turns it into a data point.
// Nothing here knows who anyone is: the visitor id is a random string the browser made up, never an account id.

/** The only events we keep. Anything else is dropped. */
export const EVENT_NAMES = [
  'view', 'popup_open', 'save', 'vote', 'checkin', 'report', 'share', 'outbound', 'filter', 'search',
  'ask_send', 'signin_start', 'signin_done', 'submit_done', 'pwa_install',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const NAMES = new Set<string>(EVENT_NAMES);
const MAX_EVENTS = 10;

export interface CleanEvent {
  name: EventName;
  /** The page: home, add, saved, me, connect... */
  route: string;
  /** A pop-up's slug (public) for view, popup_open, save, vote, checkin, report, share, outbound. */
  slug: string;
  /** One short fact from a closed list: a category, a filter like `cat:food`, a vote kind. Never typed text. */
  detail: string;
  /** Referrer host, only on the first view of a visit. */
  ref: string;
  /** A number: 1 or 0 for on/off, the vote value, 1 on the first view of a visit. */
  x: number;
}

export interface CleanBatch {
  /** Random id the browser keeps on the device. Not linked to any account. */
  vid: string;
  signedIn: 0 | 1;
  device: 'm' | 'd';
  events: CleanEvent[];
}

const VID = /^[A-Za-z0-9]{8,32}$/;
const ROUTE = /^[a-z0-9_-]{1,24}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DETAIL = /^[a-z0-9_:.-]{1,40}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,59}$/;

const pick = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : '');

/** Null when the body is not a batch we understand. Single bad events are dropped, not the whole batch. */
export function cleanBatch(body: unknown): CleanBatch | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const vid = pick(b.v, VID);
  if (!vid || !Array.isArray(b.events)) return null;
  const events: CleanEvent[] = [];
  for (const raw of b.events.slice(0, MAX_EVENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.e !== 'string' || !NAMES.has(e.e)) continue;
    const x = typeof e.x === 'number' && Number.isFinite(e.x) ? Math.max(-1e6, Math.min(1e6, e.x)) : 0;
    events.push({ name: e.e as EventName, route: pick(e.r, ROUTE), slug: pick(e.p, SLUG), detail: pick(e.d, DETAIL), ref: pick(e.f, HOST), x });
  }
  if (!events.length) return null;
  return { vid, signedIn: b.s === 1 ? 1 : 0, device: b.w === 'm' ? 'm' : 'd', events };
}

/**
 * The data point for Workers Analytics Engine. The column order is the contract with src/db/insights.ts:
 * index1 visitor; blob1 event, blob2 route, blob3 slug, blob4 detail, blob5 referrer, blob6 device, blob7 country;
 * double1 signed in (1/0), double2 x.
 */
export function toDataPoint(batch: CleanBatch, e: CleanEvent, country: string): AnalyticsEngineDataPoint {
  return {
    indexes: [batch.vid],
    blobs: [e.name, e.route, e.slug, e.detail, e.ref, batch.device, /^[A-Z]{2}$/.test(country) ? country : ''],
    doubles: [batch.signedIn, e.x],
  };
}
