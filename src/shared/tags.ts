// The one list of pop-up tags (docs/superpowers/specs/2026-10-08-scout-tags-design.md). The Worker, the web app and
// the agent tools all import it.
//
// A tag is a fact the organiser's page states, not an opinion, and it comes from this closed list only: no text from
// a page or a post can reach the public list or an agent brief through a tag. Unlike a category, a tag is not a SQL
// CHECK, so adding or retiring one is a code change and needs no migration.
//
// popups.tags holds NULL (nobody has looked yet), '' (looked, none apply) or ',a,b,' (sorted keys, a comma at each end,
// so a tag is found with instr(tags, ',a,') and never with LIKE, where "_" is a wildcard).

export interface TagInfo {
  label: string;
  /** One line for agents and for the Concierge brief: when the tag is right. */
  means: string;
  /** Says something a visitor will rely on (who may come, what is served, when), so an agent needs a quote from the page. */
  claim: boolean;
}

export const TAG_INFO = {
  // what you do
  interactive: { label: 'Interactive', means: 'you play, make, try or take part (games, demos, make-your-own, workshops)', claim: false },
  immersive: { label: 'Immersive', means: 'a walk-through environment or installation you step inside', claim: false },
  tasting: { label: 'Tasting', means: 'there is food or drink to taste or sample', claim: false },
  live_music: { label: 'Live music', means: 'a live act or a DJ is part of it', claim: false },
  talk: { label: 'Talk', means: 'a talk, panel, Q&A or signing', claim: false },
  shopping: { label: 'Shopping', means: 'limited products, drops or vendors to buy from', claim: false },
  freebies: { label: 'Freebies', means: 'free gifts or samples to take away', claim: false },
  // theme
  vintage: { label: 'Vintage', means: 'vintage, second-hand, thrifted or archive', claim: false },
  vegan: { label: 'Vegan', means: 'vegan or plant-based', claim: true },
  collab: { label: 'Collab', means: 'a collaboration between two brands, makers or chefs', claim: false },
  fandom: { label: 'Fandom', means: 'a tie-in with a film, show, game, anime or band', claim: false },
  makers: { label: 'Makers', means: 'independent makers or small brands, not one big brand', claim: false },
  // practical
  outdoors: { label: 'Outdoors', means: 'it takes place outside (street, park, rooftop, courtyard)', claim: false },
  late_night: { label: 'Late night', means: 'it is open until 10pm or later', claim: true },
  booking_needed: { label: 'Booking needed', means: 'a ticket, booking or RSVP is needed or advised', claim: true },
  family: { label: 'Family', means: 'children or families are welcome (kids\' activities, family day)', claim: true },
  adults_only: { label: 'Adults only', means: '18+ or 21+ is stated', claim: true },
  dog_friendly: { label: 'Dog friendly', means: 'dogs are welcome', claim: true },
} as const satisfies Record<string, TagInfo>;

export type Tag = keyof typeof TAG_INFO;

/** In display order. */
export const TAGS = Object.keys(TAG_INFO) as Tag[];
export const TAG_LABELS = Object.fromEntries(TAGS.map(t => [t, TAG_INFO[t].label])) as Record<Tag, string>;
/** Tags that need a quote from the page, found by Spotted, before an agent may set them. */
export const CLAIM_TAGS = TAGS.filter(t => TAG_INFO[t].claim);

/** Most tags on one pop-up: the most defining ones, not every one that fits. */
export const MAX_TAGS = 5;

export const isTag = (s: unknown): s is Tag => typeof s === 'string' && Object.prototype.hasOwnProperty.call(TAG_INFO, s);
export const isClaimTag = (t: Tag) => TAG_INFO[t].claim;

/** The stored column as a list. Null means nobody has looked yet; unknown keys (a retired tag) are ignored. */
export function parseTagColumn(v: string | null | undefined): Tag[] | null {
  if (v === null || v === undefined) return null;
  return v.split(',').filter(isTag);
}

/** The list as it is stored: sorted, no repeats, valid keys only, at most MAX_TAGS. Null stays null (not looked at). */
export function formatTagColumn(tags: readonly string[] | null | undefined): string | null {
  if (tags === null || tags === undefined) return null;
  const keep = [...new Set(tags.filter(isTag))].sort().slice(0, MAX_TAGS);
  return keep.length ? `,${keep.join(',')},` : '';
}

/**
 * Reads a list of tags from an argument or a request body. `tags` are the valid ones in the order given (repeats
 * removed, at most MAX_TAGS), `dropped` is everything else, so an agent can be told what was not taken.
 */
export function cleanTags(raw: unknown): { tags: Tag[]; dropped: string[] } {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const tags: Tag[] = [];
  const dropped: string[] = [];
  for (const v of list) {
    const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    if (isTag(s)) {
      if (tags.includes(s)) continue;
      if (tags.length >= MAX_TAGS) dropped.push(s);
      else tags.push(s);
    } else if (s) dropped.push(typeof v === 'string' ? v.trim().slice(0, 40) : String(v).slice(0, 40));
  }
  return { tags, dropped: dropped.slice(0, 20) };
}

/** What `tag=` and `avoid=` in a list request mean: valid keys, or an error text when one is not a tag. */
export function tagFilter(raw: string | undefined): { tags: Tag[] } | { error: string } {
  if (!raw) return { tags: [] };
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const bad = parts.find(p => !isTag(p));
  if (bad) return { error: `Tag must be one of: ${TAGS.join(', ')}.` };
  return { tags: parts as Tag[] };
}

/** The list a person reads, for a prompt or a message: "interactive, late night". */
export const tagsText = (tags: readonly string[]) => tags.filter(isTag).map(t => TAG_LABELS[t].toLowerCase()).join(', ');
