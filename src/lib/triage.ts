// What a Triage or Checker agent may do on its own to a post, instead of leaving it to the admin (Zack, 2026-10-04):
// cut a sentence no page supports, correct a field to what the page says, accept two readable sites for a source Spotted
// cannot open, and remove or end a post it can show is a duplicate, out of scope or cancelled. Pure helpers here; the
// database side is in src/db/triage.ts.

export const OUT_OF_SCOPE_REASONS = ['performance', 'regular_offer', 'private_or_trade', 'not_a_pop_up'] as const;
export type OutOfScopeReason = typeof OUT_OF_SCOPE_REASONS[number];

export const CLEARABLE_FIELDS = ['price_text', 'hours_text'] as const;
export const SETTABLE_FIELDS = ['address', 'price_text', 'hours_text'] as const;

/** Most sentences one note may cut, and the farthest a corrected date may move. A bigger change is for a person. */
export const MAX_CUTS = 6;
export const MAX_DATE_SHIFT_DAYS = 7;
/** Fixes, removals and endings one agent may make in 24 hours. Past this its notes still go to the queue. */
export const AGENT_ACTIONS_PER_DAY = 40;
/** A description that is shorter than this after the cuts is not worth publishing. */
export const MIN_DESCRIPTION = 20;

export class FixError extends Error {}

export interface Fixes {
  remove_text: string[];
  clear: (typeof CLEARABLE_FIELDS)[number][];
  set: Partial<Record<(typeof SETTABLE_FIELDS)[number] | 'start_date' | 'end_date', string>>;
}

const SET_KEYS = [...SETTABLE_FIELDS, 'start_date', 'end_date'] as const;

/** Reads the `fixes` argument of add_note. Returns null when there is nothing to do. */
export function parseFixes(raw: unknown): Fixes | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FixError('fixes must be an object.');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter(k => !['remove_text', 'clear', 'set'].includes(k));
  if (extra.length) throw new FixError(`fixes has no field ${extra[0]}. Use remove_text, clear or set.`);
  const strings = (v: unknown, name: string, max: number): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) throw new FixError(`${name} must be a list of strings.`);
    if (v.length > max) throw new FixError(`${name} takes at most ${max} items.`);
    return (v as string[]).map(s => s.trim()).filter(Boolean);
  };
  const remove_text = strings(r.remove_text, 'fixes.remove_text', MAX_CUTS);
  const clear = strings(r.clear, 'fixes.clear', 2) as Fixes['clear'];
  for (const c of clear) if (!(CLEARABLE_FIELDS as readonly string[]).includes(c)) throw new FixError(`fixes.clear can only blank ${CLEARABLE_FIELDS.join(' or ')}.`);
  const set: Fixes['set'] = {};
  if (r.set !== undefined) {
    if (typeof r.set !== 'object' || r.set === null || Array.isArray(r.set)) throw new FixError('fixes.set must be an object.');
    for (const [k, v] of Object.entries(r.set as Record<string, unknown>)) {
      if (!(SET_KEYS as readonly string[]).includes(k)) throw new FixError(`fixes.set can change ${SET_KEYS.join(', ')}; not ${k}.`);
      if (typeof v !== 'string' || !v.trim()) throw new FixError(`fixes.set.${k} must be a non-empty string.`);
      set[k as keyof Fixes['set']] = v.trim().slice(0, k === 'address' ? 200 : k === 'hours_text' ? 120 : k === 'price_text' ? 80 : 10);
    }
  }
  if (!remove_text.length && !clear.length && !Object.keys(set).length) return null;
  return { remove_text, clear, set };
}

/** Removes each piece from the text, once, and tidies the spaces. `missing` lists the pieces that were not there. */
export function cutText(text: string, pieces: readonly string[]): { text: string; missing: string[] } {
  let out = text;
  const missing: string[] = [];
  for (const piece of pieces) {
    const at = out.indexOf(piece);
    if (at < 0) { missing.push(piece); continue; }
    out = out.slice(0, at) + out.slice(at + piece.length);
  }
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;!?])/g, '$1').replace(/\n[ \t]+/g, '\n').trim(), missing };
}

const MONTHS: [string, string][] = [
  ['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], ['may', 'may'], ['jun', 'june'],
  ['jul', 'july'], ['aug', 'august'], ['sep', 'september'], ['oct', 'october'], ['nov', 'november'], ['dec', 'december'],
];

/** True when the quote names that day and month: "14 November", "14th Nov", "Nov 14", "5 to 14 Nov", "14/11" or "2026-11-14". */
export function dateOnPage(quote: string, iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [, y, mo, d] = m;
  const day = String(Number(d)), month = Number(mo);
  const q = quote.toLowerCase();
  if (q.includes(iso)) return true;
  const [short, long] = MONTHS[month - 1];
  const name = `(?:${long}|${short}(?:t)?\\.?)`;
  const dayRe = `0?${day}(?:st|nd|rd|th)?`;
  if (new RegExp(`\\b${dayRe}(?:\\s+of)?\\s+${name}\\b`).test(q)) return true;
  // The first day of a range names the month only after the last day: "5 to 12 October", "5-12 Oct", "5 and 6 October".
  if (new RegExp(`\\b${dayRe}\\s*(?:-|to|until|till|and|&)\\s*\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+${name}\\b`).test(q)) return true;
  if (new RegExp(`\\b${name}\\s+${dayRe}\\b`).test(q)) return true;
  return new RegExp(`\\b0?${day}\\s*[/.]\\s*0?${month}(?:\\s*[/.]\\s*(?:${y}|${y.slice(2)}))?\\b`).test(q);
}

/** The site a link belongs to: host without www, and the last two labels (three under co.uk and the like). */
export function siteOf(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  const labels = host.split('.');
  if (labels.length < 2) return null;
  const secondLevel = ['co', 'org', 'gov', 'ac', 'com', 'net'];
  const keep = labels.length >= 3 && labels[labels.length - 1].length === 2 && secondLevel.includes(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** At least two pages from different sites. */
export const differentSites = (urls: readonly string[]): boolean => new Set(urls.map(siteOf).filter(Boolean)).size >= 2;
