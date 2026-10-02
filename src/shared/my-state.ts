// Your saves and votes, kept apart from the public pop-up list (GET /me/state). Plain functions with no
// imports, so the Worker tests and the web app run the same code.

/** Saved pop-up ids and your votes by pop-up id (0 means no vote). */
export interface MyStateMap { saved: string[]; votes: Record<string, { existence: number; quality: number }> }
export interface MyStatePatch { saved?: boolean; existence_vote?: number; quality_vote?: number }
export interface MyStateOnItem { saved: boolean; existence_vote: number; quality_vote: number }

/** The map after one change, as a new object. */
export function patchState(prev: MyStateMap, id: string, patch: MyStatePatch): MyStateMap {
  const saved = patch.saved === undefined ? prev.saved : patch.saved ? [...new Set([...prev.saved, id])] : prev.saved.filter(x => x !== id);
  if (patch.existence_vote === undefined && patch.quality_vote === undefined) return { saved, votes: prev.votes };
  const cur = prev.votes[id] ?? { existence: 0, quality: 0 };
  return { saved, votes: { ...prev.votes, [id]: { existence: patch.existence_vote ?? cur.existence, quality: patch.quality_vote ?? cur.quality } } };
}

/** Adds `me` to every item. Without a map (signed out, still loading) the list is returned as it is. */
export function mergeMe<T extends { id: string }>(items: T[], s: MyStateMap | null | undefined): (T & { me?: MyStateOnItem })[] {
  if (!s) return items;
  const saved = new Set(s.saved);
  return items.map(p => ({ ...p, me: { saved: saved.has(p.id), existence_vote: s.votes[p.id]?.existence ?? 0, quality_vote: s.votes[p.id]?.quality ?? 0 } }));
}
