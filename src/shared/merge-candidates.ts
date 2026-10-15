import { haversine } from '../lib/geo';
import { rangesTouch, type Range } from './ranges';

/** What the merge picker needs from a pop-up (the public list item has more). */
export interface MergeItem { id: string; title: string; host: string | null; start_at: number; end_at: number; ranges?: Range[]; location: { lat: number; lng: number } }

/** Close enough that two posts may be the same place. Looser than the 300 m duplicate check on purpose: a person decides here. */
export const NEAR_M = 800;
const SHOWN = 8;
const STOP = new Set(['pop', 'popup', 'up', 'the', 'and', 'london', 'by', 'at', 'of', 'with', 'for']);

/** Words too common to say two pop-ups are the same one (the finder drops them; the picker keeps them because a person reads it). */
const GENERIC = new Set(['market', 'sale', 'shop', 'store', 'night', 'festival', 'exhibition', 'launch', 'event', 'weekend', 'summer', 'winter', 'spring', 'autumn', 'free', 'open', 'new', 'day', 'special', 'collection']);

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
    .filter(p => p.start_at < from.end_at && p.end_at > from.start_at && rangesTouch(p, from))
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

/** What the duplicate finder reads from a public list item. All of it is already in the public snapshot. */
export interface PairItem extends MergeItem { category?: string; source_url?: string | null; status?: string; verification?: { voters: number }; created_at?: number }

export interface DuplicatePair { key: string; a: PairItem; b: PairItem; score: number; why: string[]; keep: 'a' | 'b' }

/** The same pair has the same key whichever way round it is found, so "not the same" can be remembered. */
export const pairKey = (x: string, y: string) => (x < y ? `${x}:${y}` : `${y}:${x}`);

const STATUS_RANK: Record<string, number> = { verified_admin: 3, verified_community: 2, community: 1 };
const sourceOf = (u?: string | null) => (u ? u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '') : '');

/** The one worth keeping: the more trusted, then the one more people voted on, then the older. */
function keeper(a: PairItem, b: PairItem): 'a' | 'b' {
  const rank = (p: PairItem) => STATUS_RANK[p.status ?? ''] ?? 0;
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? 'a' : 'b';
  const voters = (p: PairItem) => p.verification?.voters ?? 0;
  if (voters(a) !== voters(b)) return voters(a) > voters(b) ? 'a' : 'b';
  return (a.created_at ?? 0) <= (b.created_at ?? 0) ? 'a' : 'b';
}

/**
 * Pairs of listed pop-ups that may be the same one, best first. Dates must overlap, they must be within 800 m and
 * share a word in the title or host; then distance, how many words match, the same category and the same source
 * link add up to a score. Pop-ups are put in a grid so a list of thousands is not compared pair by pair (this runs
 * in the admin's browser: the Worker has about 10 ms of CPU). A pair in `dismissed` (see `pairKey`) is left out.
 * It only suggests: a person decides, and a venue with two shows will show up here too.
 */
export function duplicatePairs(items: PairItem[], dismissed: ReadonlySet<string> = new Set(), minScore = 4): DuplicatePair[] {
  const cell = (p: PairItem) => [Math.floor(p.location.lat / 0.01), Math.floor(p.location.lng / 0.015)] as const;
  const grid = new Map<string, number[]>();
  const wordsOf = items.map(p => new Set([...words(`${p.title} ${p.host ?? ''}`)].filter(w => !GENERIC.has(w))));
  items.forEach((p, i) => { const [y, x] = cell(p); const k = `${y},${x}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  const out: DuplicatePair[] = [];
  items.forEach((a, i) => {
    const [y, x] = cell(a);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${y + dy},${x + dx}`) ?? []) {
        if (j <= i) continue;
        const b = items[j];
        if (a.id === b.id || a.start_at >= b.end_at || b.start_at >= a.end_at || !rangesTouch(a, b)) continue;
        const key = pairKey(a.id, b.id);
        if (dismissed.has(key)) continue;
        const d = haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
        if (d > NEAR_M) continue;
        const common = [...wordsOf[i]].filter(w => wordsOf[j].has(w));
        if (!common.length) continue;
        const why = [`${Math.round(d / 10) * 10} m apart`, `shared: ${common.slice(0, 3).join(', ')}`];
        let score = (d <= 150 ? 3 : d <= 300 ? 2 : 1) + (common.length >= 2 ? 2 : 1);
        if (common.length / Math.min(wordsOf[i].size, wordsOf[j].size) >= 0.8) score += 1;
        if (a.category && a.category === b.category) { score += 1; why.push('same category'); }
        const s = sourceOf(a.source_url);
        if (s && s === sourceOf(b.source_url)) { score += 1; why.push('same source link'); }
        if (score >= minScore) out.push({ key, a, b, score, why, keep: keeper(a, b) });
      }
    }
  });
  return out.sort((p, q) => q.score - p.score || (p.key < q.key ? -1 : 1));
}
