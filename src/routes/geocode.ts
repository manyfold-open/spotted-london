import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireUser } from '../middleware';
import { ApiError, bad } from '../lib/util';
import { inLondon, LONDON } from '../lib/geo';

// Address search for the Add form, through Photon (OpenStreetMap data, no API key).
// Results are cached for a day with the Cache API, which has no write quota on the free plan.

export const geocode = new Hono<AppEnv>();

const PHOTON = 'https://photon.komoot.io';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

export interface Place { label: string; name: string | null; address: string; area: string | null; lat: number; lng: number }

export function toPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const area = p.district || p.locality || p.suburb || null;
  const address = [street || null, area, p.postcode].filter(Boolean).join(', ');
  const name = p.name && p.name !== p.street ? p.name : null;
  return { label: [name, address].filter(Boolean).join(', ') || p.city || 'London', name, address: address || name || 'London', area, lat, lng };
}

export type WaitUntil = { waitUntil(p: Promise<unknown>): void };

async function photon(url: string, ctx: WaitUntil | undefined): Promise<PhotonFeature[]> {
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(url);
  const res = hit ?? await fetch(url, { headers: { 'user-agent': 'SpottedLondon/0.1 (+https://spotted.london)' }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res || !res.ok) throw new ApiError(502, 'geocode_failed', 'Address search is not responding. Drop the pin on the map instead.');
  if (!hit) {
    const copy = new Response(res.clone().body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' } });
    const put = cache.put(url, copy);
    if (ctx) ctx.waitUntil(put); else await put;
  }
  const json = (await res.json()) as { features?: PhotonFeature[] };
  return json.features ?? [];
}

const ctxOf = (c: { executionCtx: WaitUntil }): WaitUntil | undefined => { try { return c.executionCtx; } catch { return undefined; } };

geocode.get('/', async c => {
  requireUser(c);
  return c.json({ items: await searchPlaces(c.req.query('q') ?? '', ctxOf(c)) });
});

/** Places in London matching a search. Also used by the MCP find_place tool. */
export async function searchPlaces(query: string, ctx?: WaitUntil): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 3) throw bad('query_too_short', 'Type at least 3 characters.');
  const params = new URLSearchParams({
    q: q.slice(0, 120), limit: '6', lang: 'en', lat: '51.5072', lon: '-0.1276',
    bbox: `${LONDON.west},${LONDON.south},${LONDON.east},${LONDON.north}`,
  });
  const features = await photon(`${PHOTON}/api/?${params}`, ctx);
  return features.map(toPlace).filter(p => inLondon(p.lat, p.lng));
}

geocode.get('/reverse', async c => {
  requireUser(c);
  const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inLondon(lat, lng)) throw bad('outside_london', 'The pin must be in London.');
  // ~10 m precision keeps the cache useful
  const features = await photon(`${PHOTON}/reverse?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}&lang=en&limit=1`, ctxOf(c));
  const place = features[0] ? { ...toPlace(features[0]), lat, lng } : { label: 'Dropped pin', name: null, address: 'Dropped pin', area: null, lat, lng };
  return c.json(place);
});
