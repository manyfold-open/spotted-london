import { haversine } from '../lib/geo';

/** What the merge picker needs from a pop-up (the public list item has more). */
export interface MergeItem { id: string; title: string; host: string | null; start_at: number; end_at: number; location: { lat: number; lng: number } }

/** Close enough that two posts may be the same place. Looser than the 300 m duplicate check on purpose: a person decides here. */
export const NEAR_M = 800;
const SHOWN = 8;
const STOP = new Set(['pop', 'popup', 'up', 'the', 'and', 'london', 'by', 'at', 'of', 'with', 'for']);

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));

/**
 * Pop-ups an admin may merge `from` into, best first: the ones whose dates overlap and that are near it or share a word
 * with its title or host. With a typed search it is any title or host that contains the text instead, nearest first.
 * Pure, so it runs in the browser on the list it already has.
 */
export function mergeCandidates(items: MergeItem[], from: MergeItem, query = ''): MergeItem[] {
  const q = query.trim().toLowerCase();
  const dist = (p: MergeItem) => haversine(from.location.lat, from.location.lng, p.location.lat, p.location.lng);
  const others = items.filter(p => p.id !== from.id);
  if (q) {
    return others.filter(p => `${p.title} ${p.host ?? ''}`.toLowerCase().includes(q)).sort((a, b) => dist(a) - dist(b)).slice(0, SHOWN);
  }
  const mine = words(`${from.title} ${from.host ?? ''}`);
  const scored = others
    .filter(p => p.start_at < from.end_at && p.end_at > from.start_at)
    .map(p => {
      const d = dist(p);
      let shared = 0;
      for (const w of words(`${p.title} ${p.host ?? ''}`)) if (mine.has(w)) shared++;
      return { p, d, score: (d <= NEAR_M ? 1 : 0) + Math.min(shared, 3) };
    })
    .filter(x => x.score > 0 && (x.d <= NEAR_M || x.score >= 2))
    .sort((a, b) => b.score - a.score || a.d - b.d);
  return scored.slice(0, SHOWN).map(x => x.p);
}
