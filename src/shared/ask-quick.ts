// What Ask shows while the agent is still thinking: the pop-ups the filters and "For you" would pick, steered by the
// obvious words in the question (when, free, a category, an area). It is a stand-in and never claims to be the answer.
// Plain functions with no Worker imports, so the web app and the tests run the same code.

import { filterPopups, type ListItem } from './filter-popups';
import { forYou, type Taste, type TasteItem } from './taste';
import type { Category } from './categories';

export interface Guess { when: 'today' | 'weekend' | 'week'; free: boolean; categories: Category[]; borough: string | null }

const WORDS: [Category, RegExp][] = [
  ['food', /\b(food|drinks?|bars?|coffee|cafes?|matcha|tastings?|street ?food|cocktails?|beer|wine|snacks?|brunch)\b/],
  ['dining', /\b(supper|dinners?|residenc(?:y|ies)|chefs?)\b/],
  ['market', /\b(markets?|fairs?|stalls?)\b/],
  ['exhibition', /\b(exhibitions?|galler(?:y|ies)|museums?)\b/],
  ['art', /\b(art|installations?|sculptures?|murals?)\b/],
  ['event', /\b(party|parties|festivals?|talks?|gigs?|lates?|music|club|clubs)\b/],
  ['fashion', /\b(fashion|clothes|clothing|vintage|streetwear|thrift)\b/],
  ['sample', /\b(sample|sales?|discounts?)\b/],
  ['beauty', /\b(beauty|make-?up|skincare|perfume|nails)\b/],
  ['tech', /\b(tech|gadgets?|gaming|games?|vr)\b/],
];

/** `boroughs` are the area names found in the list, so "Shoreditch" is recognised without a place list of our own. */
export function quickGuess(text: string, boroughs: string[]): Guess {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ')} `;
  const when = /\b(tonight|today|this evening)\b/.test(t) ? 'today' : /\b(weekend|saturday|sunday)\b/.test(t) ? 'weekend' : 'week';
  const borough = boroughs.find(b => b && t.includes(` ${b.toLowerCase()} `)) ?? null;
  return { when, free: /\bfree\b/.test(t), categories: WORDS.filter(([, re]) => re.test(t)).map(([c]) => c), borough };
}

/**
 * Up to `n` pop-ups for the question, from the list as it is now. If nothing matches every word, the guess is relaxed
 * one word at a time (the area first, then the category, then free) so the panel is never empty while there is anything on.
 */
export function meanwhile<T extends ListItem & TasteItem>(all: T[], text: string, taste: Taste | null, now: number, n = 5): T[] {
  const boroughs = [...new Set(all.map(p => p.location.borough).filter((b): b is string => !!b))];
  const g = quickGuess(text, boroughs);
  const tries: Partial<Guess>[] = [g, { ...g, borough: null }, { ...g, borough: null, categories: [] }, { ...g, borough: null, categories: [], free: false }];
  for (const x of tries) {
    const q: Record<string, string> = { when: x.when ?? 'week', limit: 'all' };
    if (x.categories?.length) q.category = x.categories.join(',');
    if (x.free) q.free = '1';
    if (x.borough) q.borough = x.borough;
    const items = filterPopups(all, q, now).items as T[];
    if (!items.length) continue;
    return (taste && taste.on && taste.swipes > 0 ? forYou(items, taste, !!x.categories?.length) : items).slice(0, n);
  }
  return [];
}
