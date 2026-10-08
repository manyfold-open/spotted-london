// Personal taste for the "For you" list: what someone swiped yes or no to, and how that re-orders the public list.
// Plain functions with no imports from the Worker, so the web app (which keeps the taste in localStorage) and the
// tests run the same code. Nothing here is sent to a server.

import { CATEGORIES, isCategory } from './categories';

/** What the ranking needs from a pop-up. The public list items have all of it. */
export interface TasteItem {
  id: string; category: string; hot: number; cover_url?: string | null;
  price: { type: string | null }; location: { borough: string | null };
  start_at: number; end_at: number;
}

/** Weighted yes and no counts. Saves count half a swipe, so these are not whole numbers. */
export interface Tally { y: number; n: number }

export interface Taste {
  v: 1;
  cats: Record<string, Tally>;
  boroughs: Record<string, Tally>;
  /** Yes and no to free pop-ups only. */
  free: Tally;
  /** Answers given in the deck. Skips are not counted. */
  swipes: number;
  /** "For you" is switched on. */
  on: boolean;
  /** The intro has been dealt with (finished or dismissed), so the home page stops offering it. */
  seen: boolean;
}

export const DECK_SIZE = 10;
/** How much of the "hot" scale a fully liked category is worth. Hot moves by about 3.5 across a week of start times. */
const TASTE_WEIGHT = 4;
/** A category is hidden from "For you" at or below this smoothed yes rate: two noes and no yes, or the like. */
const HIDE_AT = 0.25;
/** The deck only offers pop-ups that start within this long, so a card is never about something months away. */
const DECK_HORIZON = 21 * 24 * 3_600_000;

export const emptyTaste = (): Taste => ({ v: 1, cats: {}, boroughs: {}, free: { y: 0, n: 0 }, swipes: 0, on: false, seen: false });

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
  const swipes = typeof v.swipes === 'number' && Number.isFinite(v.swipes) ? Math.max(0, Math.min(10_000, Math.floor(v.swipes))) : 0;
  return { v: 1, cats, boroughs, free: tally(v.free), swipes, on: v.on === true, seen: v.seen === true };
}

const bump = (m: Record<string, Tally>, key: string, yes: boolean, w: number) => {
  const t = m[key] ?? { y: 0, n: 0 };
  return { ...m, [key]: yes ? { y: t.y + w, n: t.n } : { y: t.y, n: t.n + w } };
};

/**
 * One answer about one pop-up. `weight` is 1 for a swipe in the deck; softer signals (a save) use less.
 * `deck` marks an answer given on a card, which is what counts toward `swipes`.
 */
export function learn(taste: Taste, item: TasteItem, yes: boolean, weight = 1, deck = true): Taste {
  const next: Taste = { ...taste, cats: isCategory(item.category) ? bump(taste.cats, item.category, yes, weight) : taste.cats };
  const b = item.location.borough?.trim().toLowerCase();
  if (b) next.boroughs = bump(taste.boroughs, b, yes, weight);
  if (item.price.type === 'free') next.free = yes ? { y: taste.free.y + weight, n: taste.free.n } : { y: taste.free.y, n: taste.free.n + weight };
  if (deck) next.swipes = taste.swipes + 1;
  return next;
}

/** 0 to 1, how much someone is likely to like this pop-up. The category counts most; free and area nudge it. */
export function affinity(taste: Taste, item: TasteItem): number {
  let a = rate(taste.cats[item.category]);
  if (item.price.type === 'free') a = a * 0.8 + rate(taste.free) * 0.2;
  const b = item.location.borough?.trim().toLowerCase();
  if (b && taste.boroughs[b]) a = a * 0.85 + rate(taste.boroughs[b]) * 0.15;
  return a;
}

/** Categories someone has clearly said no to. "For you" leaves them out; picking one in the chips brings it back. */
export function hiddenCategories(taste: Taste): string[] {
  return CATEGORIES.filter(c => taste.cats[c] && rate(taste.cats[c]) <= HIDE_AT);
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
  let free = 0;
  const take = (cat: string) => {
    const pool = (byCat.get(cat) ?? []).filter(p => !picked.includes(p));
    if (!pool.length) return false;
    const score = (p: T) => (p.cover_url ? 2 : 0) + Math.max(0, Math.min(3, p.hot)) + rand() * 2
      + (p.price.type === 'free' ? (free < 3 ? 0.6 : -0.6) : 0)
      - (p.location.borough && areas.has(p.location.borough.toLowerCase()) ? 1 : 0);
    const best = pool.map(p => ({ p, s: score(p) })).sort((a, b) => b.s - a.s)[0].p;
    picked.push(best);
    if (best.location.borough) areas.add(best.location.borough.toLowerCase());
    if (best.price.type === 'free') free++;
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
