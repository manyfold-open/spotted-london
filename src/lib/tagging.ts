// What an agent may say about tags, in its own words: reading the arguments of submit_draft and add_note, and the cue
// each claim tag needs in its quote. No database and no network here, so test/tagging.test.ts can run it directly.
// The tags themselves come from the closed list in src/shared/tags.ts; nothing a page says becomes a tag.

import { cleanTags, isClaimTag, isTag, MAX_TAGS, type Tag } from '../shared/tags';
import { EVIDENCE_MAX, EVIDENCE_MIN } from './evidence';

/** Tag changes one Triage or Checker agent may make in 24 hours. Separate from the 40 fixes and removals. Start here, tune from the tag report. */
export const AGENT_TAG_EDITS_PER_DAY = 60;

export class TagError extends Error {}

export interface TagQuote { tag: Tag; quote: string; url: string | null }
export interface TagChange { add: Tag[]; remove: Tag[]; dropped: string[] }

/** The `tag_quotes` argument: `[{ tag, quote, url? }]`. A quote for a tag that is not a claim tag is not needed and is left out. */
export function readTagQuotes(raw: unknown): TagQuote[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TAGS + 1) throw new TagError(`tag_quotes is a list of up to ${MAX_TAGS + 1} items, each with tag and quote.`);
  const out: TagQuote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TagError('Each tag_quotes item needs a tag and a quote.');
    const o = item as Record<string, unknown>;
    const tag = typeof o.tag === 'string' ? o.tag.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    if (!isTag(tag)) throw new TagError(`tag_quotes: "${String(o.tag).slice(0, 40)}" is not a tag.`);
    if (!isClaimTag(tag) || out.some(q => q.tag === tag)) continue;
    const quote = typeof o.quote === 'string' ? o.quote.trim() : '';
    const url = typeof o.url === 'string' && o.url.trim() ? o.url.trim().slice(0, 500) : null;
    out.push({ tag, quote, url });
  }
  return out;
}

/** The `tags` argument of add_note: `{ add?, remove? }`. Words that are not tags are reported, not stored. Null when empty. */
export function readTagChange(raw: unknown): TagChange | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TagError('tags must be an object with add and remove lists.');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter(k => k !== 'add' && k !== 'remove');
  if (extra.length) throw new TagError(`tags has no field ${extra[0]}. Use add and remove.`);
  for (const k of ['add', 'remove']) if (r[k] !== undefined && !Array.isArray(r[k])) throw new TagError(`tags.${k} must be a list of tags.`);
  const add = cleanTags(r.add), remove = cleanTags(r.remove);
  const remove2 = remove.tags.filter(t => !add.tags.includes(t));
  return { add: add.tags.filter(t => !remove.tags.includes(t)), remove: remove2, dropped: [...add.dropped, ...remove.dropped].slice(0, 20) };
}

/**
 * What a quote has to say for a claim tag. Spotted finds the quote on the page, and this checks that it is about the
 * tag at all: a quote about the dates is not a reason to say a pop-up is for families. It is a cheap mechanical test,
 * not a judgement, so the agent still has to pick the right quote.
 */
export const CLAIM_CUES: Record<string, RegExp> = {
  family: /\b(kids?|child(?:ren)?|famil(?:y|ies)|all ages|toddlers?|babies|baby|under[- ]?\d+s?)\b/i,
  adults_only: /(?:\b18\s?\+|\b21\s?\+|\b(?:over|aged?|ages?)[- ]?(?:18|21)s?\b|\b(?:18|21) (?:and|or) (?:over|older|above)\b|\badults?[- ]only\b|\bno (?:children|kids|under)|\bstrictly adults?\b)/i,
  dog_friendly: /\b(dogs?|pups?|puppies|pets?|four[- ]legged)\b/i,
  vegan: /\b(vegan|plant[- ]based)\b/i,
  // 10pm or later, written in any of the usual ways
  late_night: /(?:\b(?:10|11)(?::[0-5]\d)?\s?(?:pm|p\.m\.)|\b(?:midnight|late|after dark|till late|until late)\b|\b(?:2[2-3]|0[0-3]):[0-5]\d\b|\b12(?::[0-5]\d)?\s?(?:am|a\.m\.)|\b[1-3](?::[0-5]\d)?\s?(?:am|a\.m\.))/i,
  booking_needed: /\b(book(?:ing|ed|ings)?|tickets?|rsvp|reserv\w*|register(?:ed|ation)?|sign[- ]?up|pre-?book\w*|slots?|ballot)\b/i,
};

/** Why a claim tag's quote is refused before anyone looks for it on a page, or null when it can be looked up. */
export function quoteProblem(q: TagQuote | undefined): string | null {
  if (!q) return 'needs a quote from the page (tag_quotes)';
  if (q.quote.length < EVIDENCE_MIN || q.quote.length > EVIDENCE_MAX) return `its quote must be ${EVIDENCE_MIN} to ${EVIDENCE_MAX} characters, copied word for word`;
  if (!CLAIM_CUES[q.tag]?.test(q.quote)) return 'its quote does not say anything about it. Quote the sentence that does';
  return null;
}
