// A pop-up can sit in several cached queries at once: its own detail query and any list it
// appears in. These helpers read and patch all of them together.
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { api, type MyState, type MyStateMap, type Popup } from './api';
import { mergeMe, patchState } from '../../../src/shared/my-state';

export { mergeMe };

type List = { items: Popup[] };
const LISTS = ['popups', 'saves', 'mypopups'];
const isList = (d: unknown): d is List => !!d && Array.isArray((d as List).items);

/** Your saves and votes. The public list has none, so they are laid over it on the way to the screen. */
export const MY_STATE_KEY = ['me', 'state'] as const;

/** The pop-up as some list already has it, so its sheet can open without waiting. */
export function fromLists(qc: QueryClient, slug: string): Popup | undefined {
  for (const [, d] of qc.getQueriesData<List>({ predicate: q => LISTS.includes(q.queryKey[0] as string) })) {
    const p = isList(d) ? d.items.find(x => x.slug === slug) : undefined;
    if (p) return mergeMe([p], qc.getQueryData<MyStateMap>(MY_STATE_KEY))[0];
  }
}

/** Applies `fn` to every cached copy of one pop-up and returns a function that undoes it. */
export function patchPopup(qc: QueryClient, id: string, fn: (p: Popup) => Popup): () => void {
  const before: [QueryKey, unknown][] = [];
  for (const [key, d] of qc.getQueriesData<Popup | List>({ predicate: q => q.queryKey[0] === 'popup' || LISTS.includes(q.queryKey[0] as string) })) {
    if (isList(d)) {
      if (!d.items.some(p => p.id === id)) continue;
      before.push([key, d]);
      qc.setQueryData<List>(key, { ...d, items: d.items.map(p => (p.id === id ? fn(p) : p)) });
    } else if (d && (d as Popup).id === id) {
      before.push([key, d]);
      qc.setQueryData<Popup>(key, fn(d as Popup));
    }
  }
  return () => before.forEach(([key, d]) => qc.setQueryData(key, d));
}

/**
 * Changes your saved flag or votes on one pop-up everywhere they live: the `['me','state']` map the lists
 * read, plus the detail and Saved copies that carry their own `me`. Returns a function that undoes it.
 */
export function patchMe(qc: QueryClient, id: string, patch: Partial<MyState>): () => void {
  const prev = qc.getQueryData<MyStateMap>(MY_STATE_KEY);
  if (prev) qc.setQueryData<MyStateMap>(MY_STATE_KEY, patchState(prev, id, patch));
  const undoCopies = patchPopup(qc, id, p => withMe(p, patch));
  return () => { undoCopies(); if (prev) qc.setQueryData(MY_STATE_KEY, prev); };
}

/** Your state on a pop-up with some fields changed. */
export const withMe = (p: Popup, patch: Partial<MyState>): Popup => ({
  ...p, me: { saved: false, existence_vote: 0, quality_vote: 0, ...p.me, ...patch },
});

/** The detail query for one pop-up. */
export const popupQuery = (slug: string) => ({
  queryKey: ['popup', slug],
  queryFn: () => api<Popup>(`/popups/${encodeURIComponent(slug)}`),
});

/**
 * Puts the list copy of a pop-up into its detail query, marked stale, so the sheet shows
 * straight away and fills in the rest (photos, who posted it) when the fetch lands.
 */
export function seedPopup(qc: QueryClient, slug: string) {
  if (qc.getQueryData(['popup', slug])) return;
  const p = fromLists(qc, slug); // already carries your saves and votes
  if (p) qc.setQueryData(['popup', slug], p, { updatedAt: 0 });
}

/** Starts loading a pop-up as soon as a finger lands on it or a pointer hovers it. */
export function prefetchPopup(qc: QueryClient, slug: string) {
  seedPopup(qc, slug);
  void qc.prefetchQuery({ ...popupQuery(slug), staleTime: 30_000 });
}
