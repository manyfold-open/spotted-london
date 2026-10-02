// Proposes a new category for a pop-up filed under the old eight keys, from its title, host and description.
// Only food and art rows can change, because those are the two keys whose meaning was split.
// No runtime imports on purpose: scripts/recategorize.mjs loads this file with Node's type stripping.

import type { Category } from '../shared/categories';

export interface Row { id: string; title: string; host: string | null; description: string | null; category: string }
export interface Proposal { id: string; from: string; to: Category; sure: boolean; why: string }

const MARKET = /art fair|design fair|craft fair|book fair|\bfairs?\b|\bmarkets?\b|car boot|flea/i;
const DINING = /supper club|residenc(?:y|ies)|(?:chef|kitchen|restaurant|bar)\s+takeovers?|dinner series|set menu|tasting menu|\bdinners?\b|\bchef\b|restaurant festival/i;
const EVENT = /\blates?\b|festival|anniversary|birthday|party|\btalks?\b|\bturns \d+\b/i;
const ART = /installation|sculpture|public art|mural|immersive|\bzines?\b|ceramic|pottery|\btrail\b/i;
const EXHIBITION = /exhibition|gallery|museum|solo show|group show|retrospective/i;
const FOOD_WORDS = /food|coffee|matcha|bakery|noodle|ramen|pizza|burger|brunch|dessert|gelato|tasting|wine|beer|cocktail|\bbar\b|stall/i;

function fromFood(text: string): Category | null {
  if (DINING.test(text)) return 'dining';
  if (MARKET.test(text)) return 'market';
  if (EVENT.test(text)) return 'event';
  return null;
}

function fromArt(text: string): Category | null {
  if (MARKET.test(text)) return 'market';
  if (EVENT.test(text)) return 'event';
  if (ART.test(text)) return 'art';
  if (EXHIBITION.test(text)) return 'exhibition';
  return null;
}

/**
 * Title and host decide. The description is only a weaker second look, and anything it decides is marked not sure.
 * A food row with no signal stays food, an art row with no signal becomes exhibition (most were gallery shows).
 */
export function proposeCategory(row: Row): Proposal {
  const { id, category: from } = row;
  if (from !== 'food' && from !== 'art') return { id, from, to: from as Category, sure: true, why: 'unchanged' };
  const pick = from === 'food' ? fromFood : fromArt;
  const stay: Category = from === 'food' ? 'food' : 'exhibition';
  const strong = `${row.title} ${row.host ?? ''}`;

  const hit = pick(strong);
  if (hit) return { id, from, to: hit, sure: !(from === 'food' && hit === 'event'), why: `title or host suggests ${hit}` };

  const soft = row.description ? pick(row.description) : null;
  if (soft) return { id, from, to: soft, sure: false, why: `description suggests ${soft}` };

  const looksLikeFood = from === 'food' && FOOD_WORDS.test(strong);
  return { id, from, to: stay, sure: looksLikeFood, why: looksLikeFood ? 'food words, no other signal' : `no signal, kept as ${stay}` };
}

/** One UPDATE per changed row. The `AND category = from` guard makes a second run do nothing and never overwrites a later edit. */
export function updateSql(changes: Proposal[]): string {
  const q = (s: string) => s.replace(/'/g, "''");
  return changes
    .filter(c => c.from !== c.to)
    .map(c => `UPDATE popups SET category = '${c.to}' WHERE id = '${q(c.id)}' AND category = '${c.from}';\n`)
    .join('');
}
