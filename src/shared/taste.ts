// Personal taste for the "For you" list: what someone swiped yes or no to, and how that re-orders the public list.
// Plain functions with no imports from the Worker, so the web app (which keeps the taste in localStorage) and the
// tests run the same code. Nothing here is sent to a server.

import { CATEGORIES, isCategory } from './categories';
import { isTag, TAGS } from './tags';
import type { MyStateMap } from './my-state';

/** What the ranking needs from a pop-up. The public list items have all of it. */
export interface TasteItem {
  id: string; category: string; hot: number; cover_url?: string | null;
  /** What the page states (src/shared/tags.ts). Null or missing: nobody has tagged it yet, which says nothing either way. */
  tags?: readonly string[] | null;
  price: { type: string | null }; location: { borough: string | null };
  start_at: number; end_at: number;
}

/** Weighted yes and no counts. Saves count half a swipe, so these are not whole numbers. */
export interface Tally { y: number; n: number }

/**
 * What a save or a quality vote has already put into the tallies for one pop-up, with the facts it was counted
 * under (so taking it back is exact even if the pop-up changed since). Saves and votes are state, not events:
 * the tallies hold this once per pop-up, however often the button is pressed.
 */
export interface Act {
  /** Category, normalised area (or null) and whether it was free when counted. */
  c: string; b: string | null; f: boolean;
  /** Tags it had when counted, left out when it had none. */
  t?: string[];
  /** Saved. */
  s?: true;
  /** Quality vote: 1 up, -1 down. */
  q?: 1 | -1;
}

export interface Taste {
  v: 1;
  cats: Record<string, Tally>;
  boroughs: Record<string, Tally>;
  /** Yes and no per tag (src/shared/tags.ts). Each answer counts for half as much as it does for the category. */
  tags: Record<string, Tally>;
  /** Yes and no to free pop-ups only. */
  free: Tally;
  /** Saves and quality votes already counted above, by pop-up id. Newest last. */
  acts: Record<string, Act>;
  /** Answers given in the deck. Skips are not counted. */
  swipes: number;
  /** "For you" is switched on. */
  on: boolean;
  /** The intro has been dealt with (finished or dismissed), so the home page stops offering it. */
  seen: boolean;
}

export const DECK_SIZE = 10;
/** A save is half a swipe in favour. A quality vote is a whole yes or no. */
export const SAVE_WEIGHT = 0.5;
export const QUALITY_WEIGHT = 1;
/** Most pop-ups remembered in `acts`. Past it, new saves and votes are not learned from (forgetting one would count it twice). */
export const ACTS_MAX = 1000;
/** How much of the "hot" scale a fully liked category is worth. Hot moves by about 3.5 across a week of start times. */
const TASTE_WEIGHT = 4;
/** A category is hidden from "For you" at or below this smoothed yes rate: two noes and no yes, or the like. */
const HIDE_AT = 0.25;
/** The deck only offers pop-ups that start within this long, so a card is never about something months away. */
const DECK_HORIZON = 21 * 24 * 3_600_000;
/** A tag gets this share of an answer: a swipe is a verdict on the whole pop-up, and a tag is only part of the reason. */
export const TAG_SHARE = 0.5;
/** A tag counts for ranking and for the summary only once it holds two swipes' worth (tallies are at TAG_SHARE), so one swipe never decides alone. */
export const TAG_MIN_TALLY = 2 * TAG_SHARE;
/** A tag is "leaned towards" or "skipped" at these smoothed rates: two clear swipes get there, one yes among three does not. */
const TAG_LIKE_AT = 0.65, TAG_SKIP_AT = 0.35;
/** How far the tags can move the score from the category's: a quarter of the way from neutral, so at most 0.125 either way. */
const TAG_NUDGE = 0.25;
/** The summary Ask may send names at most this many tags liked and this many avoided. */
const TAG_SUMMARY_MAX = 3;

export const emptyTaste = (): Taste => ({ v: 1, cats: {}, boroughs: {}, tags: {}, free: { y: 0, n: 0 }, acts: {}, swipes: 0, on: false, seen: false });

/** Smoothed yes rate between 0 and 1. Nothing known gives 0.5, so one answer never decides alone. */
export const rate = (t: Tally | undefined) => (((t?.y ?? 0) + 1) / ((t?.y ?? 0) + (t?.n ?? 0) + 2));

const tally = (v: unknown): Tally => {
  const o = (v ?? {}) as Partial<Tally>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(x, 1000) : 0);
  return { y: num(o.y), n: num(o.n) };
};

/** Reads what was stored. Anything odd gives an empty taste instead of an error. */
export function parseTaste(raw: string | null | undefined): Taste {
  if (!raw) return emptyTaste();
  let v: Partial<Taste> | null;
  try { v = JSON.parse(raw) as Partial<Taste> | null; } catch { return emptyTaste(); }
  if (!v || typeof v !== 'object' || v.v !== 1) return emptyTaste();
  const cats: Taste['cats'] = {};
  for (const [k, t] of Object.entries(v.cats ?? {})) if (isCategory(k)) cats[k] = tally(t);
  const boroughs: Taste['boroughs'] = {};
  for (const [k, t] of Object.entries(v.boroughs ?? {}).slice(0, 80)) boroughs[k.slice(0, 60)] = tally(t);
  const tags: Taste['tags'] = {};
  for (const [k, t] of Object.entries(v.tags ?? {}).slice(0, 80)) if (isTag(k)) tags[k] = tally(t);
  const acts: Taste['acts'] = {};
  for (const [id, a] of Object.entries(v.acts ?? {})) {
    const o = (a ?? {}) as Partial<Act>;
    const q = o.q === 1 || o.q === -1 ? o.q : undefined;
    if (Object.keys(acts).length >= ACTS_MAX || id.length > 64 || typeof o.c !== 'string' || (o.s !== true && !q)) continue;
    const t = Array.isArray(o.t) ? [...new Set(o.t.filter(isTag))].slice(0, 5) : [];
    acts[id] = { c: o.c.slice(0, 40), b: typeof o.b === 'string' ? o.b.slice(0, 60) : null, f: o.f === true, ...(t.length ? { t } : {}), ...(o.s === true ? { s: true as const } : {}), ...(q ? { q } : {}) };
  }
  const swipes = typeof v.swipes === 'number' && Number.isFinite(v.swipes) ? Math.max(0, Math.min(10_000, Math.floor(v.swipes))) : 0;
  return { v: 1, cats, boroughs, tags, free: tally(v.free), acts, swipes, on: v.on === true, seen: v.seen === true };
}

const bump = (m: Record<string, Tally>, key: string, yes: boolean, w: number) => {
  const t = m[key] ?? { y: 0, n: 0 };
  const y = Math.max(0, t.y + (yes ? w : 0)), n = Math.max(0, t.n + (yes ? 0 : w));
  const { [key]: _gone, ...rest } = m;
  return y || n ? { ...rest, [key]: { y, n } } : rest; // a tally taken back to nothing leaves no trace
};

/**
 * One answer about one pop-up. `weight` is 1 for a swipe in the deck; softer signals (a save) use less.
 * `deck` marks an answer given on a card, which is what counts toward `swipes`. A negative weight takes an
 * earlier answer back (never below zero).
 */
export function learn(taste: Taste, item: TasteItem, yes: boolean, weight = 1, deck = true): Taste {
  const next: Taste = { ...taste, cats: isCategory(item.category) ? bump(taste.cats, item.category, yes, weight) : taste.cats };
  const b = item.location.borough?.trim().toLowerCase();
  if (b) next.boroughs = bump(taste.boroughs, b, yes, weight);
  // Untagged (null) teaches nothing about tags. Tags the list no longer knows are skipped.
  let tags = taste.tags;
  for (const tag of new Set(item.tags ?? [])) if (isTag(tag)) tags = bump(tags, tag, yes, weight * TAG_SHARE);
  next.tags = tags;
  if (item.price.type === 'free') next.free = yes ? { y: Math.max(0, taste.free.y + weight), n: taste.free.n } : { y: taste.free.y, n: Math.max(0, taste.free.n + weight) };
  if (deck) next.swipes = taste.swipes + 1;
  return next;
}

const factsOf = (i: TasteItem): Pick<Act, 'c' | 'b' | 'f' | 't'> => {
  const t = [...new Set((i.tags ?? []).filter(isTag))].slice(0, 5);
  return { c: i.category.slice(0, 40), b: i.location.borough?.trim().toLowerCase() || null, f: i.price.type === 'free', ...(t.length ? { t } : {}) };
};
const asItem = (a: Act): TasteItem => ({ id: '', category: a.c, hot: 0, tags: a.t ?? null, price: { type: a.f ? 'free' : null }, location: { borough: a.b }, start_at: 0, end_at: 0 });

/** Adds (sign 1) or takes back (sign -1) what one pop-up's save and vote are worth. */
const count = (t: Taste, a: Act, sign: 1 | -1): Taste => {
  if (a.s) t = learn(t, asItem(a), true, sign * SAVE_WEIGHT, false);
  if (a.q) t = learn(t, asItem(a), a.q > 0, sign * QUALITY_WEIGHT, false);
  return t;
};

/**
 * Sets whether a pop-up is saved and what the quality vote on it is (1, -1 or 0 for none). Each is the state it
 * is now, not a click: asking for what is already counted changes nothing and returns the same object, undoing
 * is asking for the opposite, and the tallies end up as if the other state had never been counted. Swipes are
 * never touched, and neither are `on` or `seen`.
 */
export function setActs(taste: Taste, item: TasteItem, now: { saved?: boolean; quality?: number }): Taste {
  const old = taste.acts[item.id];
  const saved = now.saved ?? !!old?.s;
  const quality = now.quality === undefined ? (old?.q ?? 0) : Math.sign(now.quality);
  if (saved === !!old?.s && quality === (old?.q ?? 0)) return taste;
  if (!old && Object.keys(taste.acts).length >= ACTS_MAX) return taste;
  let t = old ? count(taste, old, -1) : taste;
  const { [item.id]: _old, ...rest } = taste.acts;
  if (!saved && !quality) return { ...t, acts: rest };
  const act: Act = { ...factsOf(item), ...(saved ? { s: true as const } : {}), ...(quality ? { q: quality as 1 | -1 } : {}) };
  return { ...count(t, act, 1), acts: { ...rest, [item.id]: act } };
}

/**
 * Brings the taste in line with the saves and votes someone has now (`mine`, from GET /me/state) on the pop-ups in
 * `items`. The first run counts what they saved and voted before this existed, a later run counts what is new
 * and takes back what is gone, and any run after that changes nothing. Pop-ups that are not in `items` are left
 * as they are, and without `mine` (signed out, still loading) nothing happens.
 */
export function syncActions(taste: Taste, items: TasteItem[], mine: MyStateMap | null | undefined): Taste {
  if (!mine) return taste;
  const saved = new Set(mine.saved);
  let t = taste;
  for (const p of items) {
    const quality = mine.votes[p.id]?.quality ?? 0;
    if (!saved.has(p.id) && !quality && !t.acts[p.id]) continue;
    t = setActs(t, p, { saved: saved.has(p.id), quality });
  }
  return t;
}

/** Starts the swipes again (Retake): forgets every swipe but keeps what saves and votes are worth. */
export function forgetSwipes(taste: Taste): Taste {
  let t: Taste = { ...emptyTaste(), seen: true, on: taste.on, acts: taste.acts };
  for (const a of Object.values(taste.acts)) t = count(t, a, 1);
  return t;
}

/** A tag someone has answered about enough times to count. */
const known = (taste: Taste, tag: string) => {
  const t = taste.tags[tag];
  return !!t && t.y + t.n >= TAG_MIN_TALLY;
};

/**
 * 0 to 1, how much someone is likely to like this pop-up. The category counts most; its tags nudge it up or down by at
 * most 0.125 (liked tags up, skipped tags down), and free and area nudge it. A pop-up nobody has tagged, or whose tags have too few answers, is scored by category alone.
 */
export function affinity(taste: Taste, item: TasteItem): number {
  let a = rate(taste.cats[item.category]);
  const tags = [...new Set(item.tags ?? [])].filter(t => isTag(t) && known(taste, t));
  if (tags.length) a = Math.min(1, Math.max(0, a + (tags.reduce((s, t) => s + rate(taste.tags[t]), 0) / tags.length - 0.5) * TAG_NUDGE));
  if (item.price.type === 'free') a = a * 0.8 + rate(taste.free) * 0.2;
  const b = item.location.borough?.trim().toLowerCase();
  if (b && taste.boroughs[b]) a = a * 0.85 + rate(taste.boroughs[b]) * 0.15;
  return a;
}

/** Categories someone has clearly said no to. "For you" leaves them out; picking one in the chips brings it back. */
export function hiddenCategories(taste: Taste): string[] {
  return CATEGORIES.filter(c => taste.cats[c] && rate(taste.cats[c]) <= HIDE_AT);
}

/**
 * The short summary Ask may send with a question: categories liked and left out, and whether free entry is liked.
 * Nothing else leaves the browser. Null when "For you" is off or says nothing yet.
 */
export interface TasteSummary {
  likes: string[]; left_out: string[]; free: 'likes' | 'avoids' | null;
  /** Tags answered about at least twice with a clear lean. Left out when there are none. Vocabulary keys only. */
  tag_likes?: string[]; tag_avoids?: string[];
}

export function tasteSummary(taste: Taste): TasteSummary | null {
  if (!taste.on || taste.swipes <= 0) return null;
  const likes = likedCategories(taste).slice(0, 4);
  const left_out = hiddenCategories(taste);
  const answers = taste.free.y + taste.free.n;
  const r = rate(taste.free);
  const free = answers >= 2 ? (r >= 0.67 ? 'likes' : r <= 0.33 ? 'avoids' : null) : null;
  const tag_likes = leaningTags(taste, true), tag_avoids = leaningTags(taste, false);
  if (!likes.length && !left_out.length && !free && !tag_likes.length && !tag_avoids.length) return null;
  return { likes, left_out, free, ...(tag_likes.length ? { tag_likes } : {}), ...(tag_avoids.length ? { tag_avoids } : {}) };
}

/** Tags with enough answers and a clear lean, strongest first. At most TAG_SUMMARY_MAX. */
function leaningTags(taste: Taste, liked: boolean): string[] {
  return TAGS.filter(t => known(taste, t) && (liked ? rate(taste.tags[t]) >= TAG_LIKE_AT : rate(taste.tags[t]) <= TAG_SKIP_AT))
    .sort((a, b) => (liked ? rate(taste.tags[b]) - rate(taste.tags[a]) : rate(taste.tags[a]) - rate(taste.tags[b])) || TAGS.indexOf(a) - TAGS.indexOf(b))
    .slice(0, TAG_SUMMARY_MAX);
}

/** Categories someone said yes to more than no, best first. */
export function likedCategories(taste: Taste): string[] {
  return CATEGORIES.filter(c => taste.cats[c] && taste.cats[c].y > taste.cats[c].n)
    .sort((a, b) => rate(taste.cats[b]) - rate(taste.cats[a]) || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
}

/**
 * The list for "For you": clearly disliked categories are left out (unless `keepHidden`, when someone picked a
 * category themselves) and the rest are ordered by hot plus how much the pop-up suits them. Ties break by id.
 */
export function forYou<T extends TasteItem>(items: T[], taste: Taste, keepHidden = false): T[] {
  const hide = keepHidden ? [] : hiddenCategories(taste);
  return items
    .filter(p => !hide.includes(p.category))
    .map(p => ({ p, s: p.hot + (affinity(taste, p) - 0.5) * TASTE_WEIGHT }))
    .sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))
    .map(r => r.p);
}

/**
 * The cards for the first run: real pop-ups that are on now or soon, one per category where possible (the
 * biggest categories first, "other" last), preferring ones with a photo, a mix of free and paid and different
 * areas. `rand` is injectable so tests get a fixed deck.
 */
export function pickDeck<T extends TasteItem>(items: T[], now: number, size = DECK_SIZE, rand: () => number = Math.random): T[] {
  const live = items.filter(p => p.end_at > now && p.start_at < now + DECK_HORIZON);
  const byCat = new Map<string, T[]>();
  for (const p of live) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p]);
  const order = [...byCat.keys()].sort((a, b) => (a === 'other' ? 1 : b === 'other' ? -1 : 0) || byCat.get(b)!.length - byCat.get(a)!.length || (a < b ? -1 : 1));

  const picked: T[] = [];
  const areas = new Set<string>();
  const shown = new Set<string>();
  let free = 0;
  const take = (cat: string) => {
    const pool = (byCat.get(cat) ?? []).filter(p => !picked.includes(p));
    if (!pool.length) return false;
    const score = (p: T) => (p.cover_url ? 2 : 0) + Math.max(0, Math.min(3, p.hot)) + rand() * 2
      + (p.price.type === 'free' ? (free < 3 ? 0.6 : -0.6) : 0)
      - (p.location.borough && areas.has(p.location.borough.toLowerCase()) ? 1 : 0)
      // a card that shows a tag the deck has not shown yet teaches something new
      + (p.tags?.some(t => !shown.has(t)) ? 0.5 : 0);
    const best = pool.map(p => ({ p, s: score(p) })).sort((a, b) => b.s - a.s)[0].p;
    picked.push(best);
    if (best.location.borough) areas.add(best.location.borough.toLowerCase());
    if (best.price.type === 'free') free++;
    for (const tag of best.tags ?? []) shown.add(tag);
    return true;
  };
  for (const c of order) { if (picked.length >= size) break; take(c); }
  // Fewer categories than cards: go round again, biggest first.
  for (let round = 0; picked.length < size && round < size; round++) {
    let any = false;
    for (const c of order) { if (picked.length >= size) break; any = take(c) || any; }
    if (!any) break;
  }
  for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [picked[i], picked[j]] = [picked[j], picked[i]]; }
  return picked;
}
