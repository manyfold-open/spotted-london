// Social posts for Scout (docs/superpowers/specs/2026-10-01-social-posts-via-apify-design.md).
// Pure helpers: which Apify actor and input a source needs, how an actor's items are read,
// the cheap keyword filter, and what a run costs. No database and no network here.

import { DAY } from './scoring';
import { normalizeUrl } from '../db/scout';

export type Platform = 'instagram' | 'threads';

export type SocialMode =
  | { platform: 'instagram'; kind: 'account' | 'tag' | 'place'; url: string; label: string }
  | { platform: 'threads'; kind: 'account'; username: string; label: string }
  | { platform: 'threads'; kind: 'search'; query: string; label: string };

/** Apify actors, as they appear in API paths. Swap one here if it stops working. */
export const ACTORS: Record<Platform, string> = {
  instagram: 'apify~instagram-scraper',
  threads: 'themineworks~threads-scraper',
};

/** Most items one run may return. */
export const MAX_ITEMS = 20;
/** Posts older than this are not worth a look. */
export const MAX_AGE = 14 * DAY;

/** Free plan price in US dollars per 1,000 results. */
const PRICE_PER_1K: Record<Platform, number> = { instagram: 2.7, threads: 2.0 };
export const itemsUsd = (p: Platform, items: number) => (items * PRICE_PER_1K[p]) / 1000;
/** Worst case for one run, held against the 30 day budget until the run finishes. */
export const reserveUsd = (p: Platform) => itemsUsd(p, MAX_ITEMS);

const IG_RESERVED = new Set(['explore', 'p', 'reel', 'reels', 'stories', 'accounts', 'direct', 'tv', 'about', 'legal', 'developer', 'login', 'challenge', 'emailsignup', 'web', 'directory']);
const IG_NAME = /^[A-Za-z0-9._]{1,30}$/;
const THREADS_NAME = /^@[A-Za-z0-9._]{1,30}$/;

/** What a social source's address asks for, or null when it cannot be fetched. */
export function socialMode(target: string): SocialMode | null {
  let u: URL;
  try { u = new URL(target); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'instagram.com') {
    if (parts[0] === 'explore' && parts[1] === 'tags' && parts[2] && parts.length === 3) {
      return { platform: 'instagram', kind: 'tag', url: `https://www.instagram.com/explore/tags/${parts[2]}/`, label: 'Instagram hashtag' };
    }
    if (parts[0] === 'explore' && parts[1] === 'locations' && /^\d+$/.test(parts[2] ?? '') && parts.length <= 4) {
      return { platform: 'instagram', kind: 'place', url: `https://www.instagram.com/explore/locations/${parts[2]}/`, label: 'Instagram place' };
    }
    if (parts.length === 1 && IG_NAME.test(parts[0]) && !IG_RESERVED.has(parts[0].toLowerCase())) {
      return { platform: 'instagram', kind: 'account', url: `https://www.instagram.com/${parts[0]}/`, label: 'Instagram account' };
    }
    return null;
  }

  if (host === 'threads.net' || host === 'threads.com') {
    if (parts.length === 1 && THREADS_NAME.test(parts[0])) {
      return { platform: 'threads', kind: 'account', username: parts[0].slice(1), label: 'Threads account' };
    }
    const q = u.searchParams.get('q')?.trim();
    if (parts.length === 1 && parts[0] === 'search' && q) {
      return { platform: 'threads', kind: 'search', query: q.slice(0, 200), label: 'Threads search' };
    }
  }
  return null;
}

/** The JSON input each actor takes. `newerThanDays` only matters for Instagram. */
export function buildInput(m: SocialMode, limit: number, newerThanDays: number): Record<string, unknown> {
  if (m.platform === 'instagram') {
    return { resultsType: 'posts', directUrls: [m.url], resultsLimit: limit, onlyPostsNewerThan: `${newerThanDays} days` };
  }
  if (m.kind === 'account') return { mode: 'profile', profileUsernames: [m.username], maxPosts: limit };
  return { mode: 'search', searchQuery: m.query, maxPosts: limit };
}

export interface SocialItem {
  url: string;
  platform: Platform;
  author: string | null;
  body: string;
  image_urls: string[];
  posted_at: number | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Threads media lists mix pictures and videos; Scout only needs pictures. */
function isVideo(u: string): boolean {
  try { return /\.(?:mp4|mov|webm|m4v)$/i.test(new URL(u).pathname); } catch { return true; }
}

function imageList(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const x of Array.isArray(v) ? v : [v]) {
      const u = typeof x === 'string' ? x : x && typeof x === 'object' ? (x as Record<string, unknown>).url : null;
      if (typeof u === 'string' && u.startsWith('https://') && !isVideo(u) && !out.includes(u)) out.push(u);
    }
  }
  return out.slice(0, 4);
}

function timeOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** One actor item as a SocialItem, or null when it has no usable address. */
export function parseItem(platform: Platform, raw: unknown): SocialItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const given = text(r.url);
  const url = given ? normalizeUrl(given) : null;
  if (!url) return null;
  if (platform === 'instagram') {
    return { url, platform, author: text(r.ownerUsername), body: text(r.caption) ?? '', image_urls: imageList(r.images, r.displayUrl), posted_at: timeOf(r.timestamp) };
  }
  return { url, platform, author: text(r.username), body: text(r.text) ?? '', image_urls: imageList(r.media_urls), posted_at: timeOf(r.posted_at) };
}

const KEYWORDS = /pop[\s-]?ups?|\bsample sales?\b|\bopening\b|\blaunch(?:es|ing)?\b|\bresidency\b|\blimited[\s-]time\b|快閃|快闪|限時|限时|開幕|开幕/i;
const OTHER_CITY = /\b(?:manchester|birmingham|liverpool|leeds|glasgow|edinburgh|bristol|brighton|newcastle|cardiff)\b/i;

/** The cheap filter: recent, talks about a pop-up, and not clearly somewhere else. */
export function passesFilter(item: SocialItem, now: number): boolean {
  if (item.posted_at !== null && now - item.posted_at > MAX_AGE) return false;
  if (!KEYWORDS.test(item.body)) return false;
  if (OTHER_CITY.test(item.body) && !/\blondon\b/i.test(item.body)) return false;
  return true;
}
