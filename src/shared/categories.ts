// The one list of pop-up categories. The Worker, the web app and the agent tools all import it.
// A new key needs, in the same change: a migration that widens the CHECK on popups.category,
// an icon symbol (c-<key>) in web/src/components/Icon.tsx, a .pat-<key> rule, a --cc-<key> colour token and a .cc-<key> rule in web/src/styles.css.
// test/categories.test.ts and test/category-assets.test.ts fail when one of those is missing.

/** In chip order. */
export const CATEGORIES = [
  'food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  food: 'Food & Drink',
  dining: 'Supper Clubs & Residencies',
  market: 'Markets & Fairs',
  exhibition: 'Exhibitions',
  art: 'Art Pop-ups',
  event: 'Events & Festivals',
  fashion: 'Fashion',
  sample: 'Sample Sale',
  beauty: 'Beauty',
  tech: 'Tech',
  other: 'Other',
};

export const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s);
