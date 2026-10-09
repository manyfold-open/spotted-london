// The public pop-up list's filters, run on an already loaded list. The browser uses this on the snapshot;
// the tests run it next to listPopups (the SQL version in src/routes/popups.ts) and demand the same answer.
// Keep the two in step: the same rules, in the same order, with the same ties broken by id.

import { boxAround, haversine } from '../lib/geo';
import { windowFor, type When } from '../lib/time';
import { CATEGORIES, isCategory } from './categories';
import { tagFilter } from './tags';

const PUBLIC = ['community', 'verified_community', 'verified_admin'];
const VERIFIED = ['verified_community', 'verified_admin'];

export interface ListItem {
  id: string; status: string; category: string; tags?: string[] | null; title: string; host: string | null; hot: number;
  price: { type: string | null }; location: { borough: string | null; lat: number; lng: number };
  start_at: number; end_at: number;
}

/**
 * Same inputs as GET /popups: when, category, tag (every one must be on the pop-up), avoid (none may be), verified, free, borough, q, near + radius_km + sort,
 * bbox, limit (1 to 50, or 'all'), cursor. Returns the page, the cursor for the next one and the time window used.
 */
export function filterPopups<T extends ListItem>(all: T[], q: Record<string, string | undefined>, now: number) {
  const when = (['today', 'weekend', 'week', 'all'].includes(q.when ?? '') ? q.when : 'week') as When;
  const { from, to } = windowFor(when, now);
  // limit 'all' returns every match in one go; the map home draws them all, and the list comes from a snapshot already in memory
  const limit = q.limit === 'all' ? Infinity : Math.min(50, Math.max(1, Number(q.limit) || 20));
  const offset = q.cursor ? parseInt(q.cursor, 36) || 0 : 0;

  const statuses = q.verified === '1' ? VERIFIED : PUBLIC;
  let rows = all.filter(p => p.end_at > from && p.start_at < to && statuses.includes(p.status));

  if (q.category) {
    const cats: string[] = q.category.split(',').filter(isCategory);
    if (!cats.length) throw new Error(`Category must be one of: ${CATEGORIES.join(', ')}.`);
    rows = rows.filter(p => cats.includes(p.category));
  }
  const want = tagFilter(q.tag), avoid = tagFilter(q.avoid);
  if ('error' in want) throw new Error(want.error);
  if ('error' in avoid) throw new Error(avoid.error);
  // An untagged pop-up (null) is not known to have any tag: it fails `tag` and passes `avoid`.
  if (want.tags.length) rows = rows.filter(p => want.tags.every(t => p.tags?.includes(t)));
  if (avoid.tags.length) rows = rows.filter(p => !avoid.tags.some(t => p.tags?.includes(t)));
  if (q.borough) { const b = q.borough.toLowerCase(); rows = rows.filter(p => p.location.borough?.toLowerCase() === b); }
  if (q.free === '1') rows = rows.filter(p => p.price.type === 'free');
  if (q.q) {
    const needle = q.q.slice(0, 80).toLowerCase();
    rows = rows.filter(p => [p.title, p.host, p.location.borough].some(f => f?.toLowerCase().includes(needle)));
  }

  let near: { lat: number; lng: number; radius: number } | null = null;
  if (q.near) {
    const [lat, lng] = q.near.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('near must be "lat,lng".');
    const radius = Math.min(20_000, Math.max(100, (Number(q.radius_km) || 2) * 1000));
    near = { lat, lng, radius };
    const b = boxAround(lat, lng, radius);
    rows = rows.filter(p => p.location.lat >= b.south && p.location.lat <= b.north && p.location.lng >= b.west && p.location.lng <= b.east);
  } else if (q.bbox) {
    const [w, s, e, n] = q.bbox.split(',').map(Number);
    if (![w, s, e, n].every(Number.isFinite)) throw new Error('bbox must be "west,south,east,north".');
    rows = rows.filter(p => p.location.lat >= s && p.location.lat <= n && p.location.lng >= w && p.location.lng <= e);
  }

  rows.sort((a, b) => b.hot - a.hot || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let scored = rows.map(p => ({ p, d: near ? haversine(near.lat, near.lng, p.location.lat, p.location.lng) : null }));
  if (near) {
    scored = scored.slice(0, 500).filter(r => (r.d ?? 0) <= near!.radius); // the SQL path reads at most 500 candidates
    if (q.sort === 'distance') scored.sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
  }
  scored = scored.slice(offset, offset + limit + 1);
  const more = scored.length > limit;
  const page = scored.slice(0, limit);
  return {
    items: page.map(r => (r.d !== null ? { ...r.p, distance_m: Math.round(r.d) } : (r.p as T & { distance_m?: number }))),
    next_cursor: more ? (offset + limit).toString(36) : null,
    window: { when, from, to: to === Number.MAX_SAFE_INTEGER ? null : to },
  };
}
