// Paste-a-link autofill (SPEC §3.8).
// 1. deterministic parsing: JSON-LD Event, then Open Graph
// 2. only if fields are still missing, and Workers AI is bound: an LLM pass
//    (pasted text goes straight to the text model, screenshots to the vision model)
// 3. deterministic post-processing (dates to London, category enum)

import { londonDateString, londonParts } from './time';
import { CATEGORIES, type Category } from '../shared/categories';

export { CATEGORIES };
export type { Category };

export type Confidence = 'high' | 'check';
export type Source = 'json_ld' | 'og' | 'llm_text' | 'llm_vision';

export interface Extracted {
  title: string | null;
  host: string | null;
  category: Category | null;
  address: string | null;
  start_date: string | null; // YYYY-MM-DD, London
  end_date: string | null;
  hours_text: string | null;
  price_text: string | null;
  description: string | null;
  image_url: string | null;
  confidence: Partial<Record<keyof Omit<Extracted, 'confidence' | 'source'>, Confidence>>;
  source: Source[];
}

export const FIELDS = ['title', 'host', 'category', 'address', 'start_date', 'end_date', 'hours_text', 'price_text', 'description', 'image_url'] as const;
type Field = (typeof FIELDS)[number];

export function emptyExtraction(): Extracted {
  return {
    title: null, host: null, category: null, address: null, start_date: null, end_date: null,
    hours_text: null, price_text: null, description: null, image_url: null, confidence: {}, source: [],
  };
}

/* ---------------- HTML parsing ---------------- */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** All JSON-LD objects in the page, flattened (handles arrays and @graph). */
export function jsonLdObjects(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (o['@graph']) walk(o['@graph']);
    }
  };
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* ignore broken blocks */ }
  }
  return out;
}

const isEventType = (t: unknown) =>
  (Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /Event$/.test(x));

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return decodeEntities(v).trim() || null;
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === 'object' && 'name' in v) return str((v as { name: unknown }).name);
  return null;
};

export function parseJsonLdEvent(html: string, now = Date.now()): Partial<Extracted> | null {
  const ev = jsonLdObjects(html).find(o => isEventType(o['@type']));
  if (!ev) return null;
  const loc = (Array.isArray(ev.location) ? ev.location[0] : ev.location) as Record<string, unknown> | undefined;
  let address: string | null = null;
  if (loc) {
    const a = loc.address;
    const parts = typeof a === 'string'
      ? [str(loc.name), a]
      : a && typeof a === 'object'
        ? [str(loc.name), ...['streetAddress', 'addressLocality', 'postalCode'].map(k => str((a as Record<string, unknown>)[k]))]
        : [str(loc.name)];
    address = uniq(parts.filter((x): x is string => !!x)).join(', ') || null;
  }
  const offers = (Array.isArray(ev.offers) ? ev.offers[0] : ev.offers) as Record<string, unknown> | undefined;
  let price: string | null = null;
  if (offers) {
    const p = offers.price ?? offers.lowPrice;
    if (p !== undefined && p !== null && p !== '') price = +p === 0 ? 'Free' : `From ${currency(offers.priceCurrency)}${p}`;
  }
  const start = toLondonDate(str(ev.startDate), now);
  const end = toLondonDate(str(ev.endDate), now) ?? start;
  const startTime = timeOf(str(ev.startDate)), endTime = timeOf(str(ev.endDate));
  return {
    title: str(ev.name),
    host: str(ev.organizer) ?? str(ev.performer),
    address,
    start_date: start,
    end_date: end,
    hours_text: startTime && endTime ? `${startTime} to ${endTime}` : null,
    price_text: price,
    description: clip(str(ev.description), 600),
    image_url: str(ev.image),
  };
}

export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([a-z:_-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? '';
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !(key in out)) out[key] = decodeEntities(attrs.content).trim();
  }
  return out;
}

export function parseOpenGraph(html: string): Partial<Extracted> {
  const t = metaTags(html);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    title: t['og:title'] || t['twitter:title'] || (titleTag ? decodeEntities(titleTag).trim() : null) || null,
    host: t['og:site_name'] || null,
    description: clip(t['og:description'] || t['description'] || t['twitter:description'] || null, 600),
    image_url: t['og:image'] || t['twitter:image'] || null,
  };
}

/** Visible text for the LLM: strips scripts, styles and tags, capped in length. */
export function readableText(html: string, max = 8000): string {
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return text.slice(0, max);
}

/* ---------------- merging + normalising ---------------- */

/** Fill empty fields of `into` from `from`, tagging where each field came from. */
export function mergeInto(into: Extracted, from: Partial<Extracted> | null, source: Source, conf: Confidence) {
  if (!from) return;
  let used = false;
  for (const f of FIELDS) {
    const v = from[f];
    if (into[f] == null && v != null && v !== '') {
      (into as unknown as Record<Field, unknown>)[f] = v;
      into.confidence[f] = conf;
      used = true;
    }
  }
  if (used && !into.source.includes(source)) into.source.push(source);
}

export function missing(e: Extracted): Field[] {
  return (['title', 'address', 'start_date', 'end_date', 'category'] as Field[]).filter(f => e[f] == null);
}

// Order matters: the first rule that matches wins. A dated chef or restaurant meal is dining before it is food,
// an art fair is a market before it is art, and a festival dinner is dining before it is an event.
const CATEGORY_WORDS: [Category, RegExp][] = [
  ['sample', /sample sale|warehouse sale|% off|up to \d+%|clearance/i],
  ['market', /art fair|design fair|craft fair|book fair|\bfairs?\b|\bmarkets?\b|car boot|makers|flea|stalls/i],
  ['dining', /supper club|residenc(?:y|ies)|(?:chef|kitchen|restaurant|bar)\s+takeovers?|dinner series|set menu|tasting menu|\bdinners?\b|restaurant festival/i],
  ['food', /food|coffee|matcha|bakery|noodle|ramen|pizza|burger|brunch|dessert|gelato|tasting|chef|wine|beer|cocktail/i],
  ['event', /\blates?\b|festival|anniversary|birthday|party|\btalks?\b/i],
  ['art', /installation|sculpture|public art|mural|immersive|\bzines?\b|ceramic|pottery|\btrail\b/i],
  ['exhibition', /exhibition|gallery|museum|solo show|group show|retrospective/i],
  ['fashion', /fashion|vintage|clothing|denim|sneaker|streetwear|thrift|kilo sale|jewellery|jewelry/i],
  ['beauty', /beauty|perfume|fragrance|skincare|makeup|cosmetic|nail/i],
  ['tech', /tech|gadget|gaming|robot|repair|3d print|vr\b/i],
];
export function guessCategory(text: string): Category | null {
  for (const [c, re] of CATEGORY_WORDS) if (re.test(text)) return c;
  return null;
}

// Spoken forms an LLM or a person might answer with, tried when the answer is not a key.
const CATEGORY_ALIASES: [RegExp, Category][] = [
  [/sample/, 'sample'],
  [/supper|residen|dinner/, 'dining'],
  [/fair/, 'market'],
  [/exhibit|gallery|museum/, 'exhibition'],
  [/festival|event|party|\blates?\b/, 'event'],
  [/installation|sculpture|public art/, 'art'],
];

export function normaliseCategory(v: unknown): Category | null {
  const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  for (const [re, c] of CATEGORY_ALIASES) if (re.test(s)) return c;
  return s ? guessCategory(s) : null;
}

/** ISO date/datetime to London calendar date. Bare dates stay as they are. */
export function toLondonDate(v: string | null, _now: number): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : londonDateString(t);
}

function timeOf(v: string | null): string | null {
  if (!v || !/T\d{2}:\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const p = londonParts(t);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** Final pass: enum category, sane dates, trimmed strings. Flags anything doubtful as 'check'. */
export function finalise(e: Extracted, context: string, now: number): Extracted {
  if (e.category == null) {
    // Title first, then description, then the page text, so page chrome never outvotes what the title says.
    const g = guessCategory(e.title ?? '') ?? guessCategory(e.description ?? '') ?? guessCategory(context);
    if (g) { e.category = g; e.confidence.category = 'check'; }
  }
  const today = londonDateString(now);
  for (const f of ['start_date', 'end_date'] as const) {
    const v = e[f];
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { e[f] = null; delete e.confidence[f]; }
  }
  if (e.start_date && !e.end_date) { e.end_date = e.start_date; e.confidence.end_date = 'check'; }
  if (e.start_date && e.end_date && e.end_date < e.start_date) { e.end_date = e.start_date; e.confidence.end_date = 'check'; }
  if (e.end_date && e.end_date < today) e.confidence.end_date = 'check'; // looks like a past event
  for (const f of FIELDS) {
    const v = e[f];
    if (typeof v === 'string') (e as unknown as Record<Field, unknown>)[f] = v.trim().slice(0, f === 'description' ? 2000 : 200) || null;
  }
  return e;
}

/* ---------------- LLM pass (Workers AI) ---------------- */

export const LLM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    host: { type: ['string', 'null'] },
    category: { type: ['string', 'null'], description: `one of ${CATEGORIES.join(', ')}` },
    address: { type: ['string', 'null'] },
    start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    hours_text: { type: ['string', 'null'] },
    price_text: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    unsure: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'category', 'address', 'start_date', 'end_date'],
} as const;

function systemPrompt(now: number, from: string) {
  const p = londonParts(now);
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.dow];
  return {
    role: 'system',
    content:
      `You extract details of a London pop-up event from ${from}. ` +
      `Today is ${weekday} ${londonDateString(now)} in London. Resolve relative dates like "this Saturday" or "one week only" against today. ` +
      `category must be one of: ${CATEGORIES.join(', ')}. Use null for anything it does not say. Never invent an address or a date. ` +
      'List in "unsure" the field names you had to guess. Reply with JSON only.',
  };
}

export function llmPrompt(text: string, now: number) {
  return [systemPrompt(now, 'a social post or web page'), { role: 'user', content: text }];
}

/** Screenshot of a post (Instagram, TikTok, a poster). `image` is a data: URI. */
export function llmVisionPrompt(image: string, now: number) {
  return [
    systemPrompt(now, 'a screenshot of a social post, event page or poster'),
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the text in this screenshot, including the caption and any text on the image, and extract the pop-up details.' },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ];
}

export function fromLlm(raw: unknown): { fields: Partial<Extracted>; unsure: string[] } {
  let o: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    try { o = m ? JSON.parse(m[0]) : {}; } catch { o = {}; }
  } else if (raw && typeof raw === 'object') o = raw as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  return {
    fields: {
      title: s('title'), host: s('host'), category: normaliseCategory(o.category), address: s('address'),
      start_date: s('start_date'), end_date: s('end_date'), hours_text: s('hours_text'), price_text: s('price_text'),
      description: s('description'),
    },
    unsure: Array.isArray(o.unsure) ? o.unsure.filter((x): x is string => typeof x === 'string') : [],
  };
}

/* ---------------- URL safety ---------------- */

/** Only public http(s) URLs. Blocks localhost, private ranges and bare IPs. */
export function safeUrl(input: string): URL | null {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost') return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return null;
  u.hash = '';
  return u;
}

export function platformOf(u: URL): 'instagram' | 'tiktok' | 'eventbrite' | 'web' {
  const h = u.hostname.replace(/^www\./, '');
  if (h.endsWith('instagram.com')) return 'instagram';
  if (h.endsWith('tiktok.com')) return 'tiktok';
  if (h.includes('eventbrite.')) return 'eventbrite';
  return 'web';
}

/* ---------------- helpers ---------------- */

function uniq<T>(a: T[]): T[] { return [...new Set(a)]; }
function clip(s: string | null, n: number): string | null { return s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function currency(c: unknown): string { return c === 'GBP' || c == null ? '£' : c === 'EUR' ? '€' : c === 'USD' ? '$' : `${c} `; }
