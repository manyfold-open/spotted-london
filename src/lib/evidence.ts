// Evidence check (SPEC §13.4): a Scout draft carries a quote copied word for word from the page
// or post that states the facts. The server looks for that quote, so a draft cannot rest on text
// the page never said. Pure helpers here; the page fetch lives in checkEvidence().

import { decodeEntities as decodeBasic, safeUrl } from './extract';

const MORE: Record<string, string> = { ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', pound: '\u00a3' };
const decodeEntities = (s: string) => decodeBasic(s).replace(/&([a-z]+);/gi, (m, n: string) => MORE[n.toLowerCase()] ?? m);

export const EVIDENCE_MAX = 300;
export const EVIDENCE_MIN = 12;
/** Site builders such as Wix ship 1.5 MB or more, with the text far down: the Winchmore Hill Supper Club's date sat at 890 KB. */
export const MAX_HTML = 2_000_000;
/** Slow gallery sites take 5 to 10 seconds. Waiting on the network costs no Worker CPU, so this can be generous. */
export const READ_TIMEOUT_MS = 15_000;

export type EvidenceCheck = 'found' | 'unchecked';

/** Lowercase text with entities decoded and quotes, dashes and whitespace made uniform. */
export function normalizeQuote(value: string): string {
  return decodeEntities(value)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .trim()
    .toLowerCase();
}

/** Visible text of a page: scripts and styles dropped, tags turned into spaces. */
export function visibleText(html: string): string {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

/** The page's raw source with JSON string escapes undone, for pages that ship their text inside JSON. */
export function unescapedHtml(html: string): string {
  return html
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/<[^>]+>/g, ' ');
}

/** Above this many characters a page is searched around the quote, not normalised whole: the Worker has about 10 ms of CPU. */
const BIG_TEXT = 400_000;
/** The most places a quote's anchor word is tried on a big page before the search gives up. */
const MAX_ANCHOR_HITS = 300;

/** `undefined` means the search gave up, so the quote may or may not be there. */
type Found = boolean | undefined;

/** Whether `text` holds the already normalised quote `q`. Big text is normalised in windows around the quote's longest plain word. */
function windowedIncludes(text: string, q: string): Found {
  const anchor = q.match(/[a-z0-9]{5,}/g)?.reduce((a, b) => (b.length > a.length ? b : a));
  if (!anchor) return normalizeQuote(text).includes(q);
  // The page may have runs of spaces and entities that the quote does not, so the window is generous.
  const room = q.length * 4 + 400;
  const re = new RegExp(anchor, 'gi');
  let hits = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (normalizeQuote(text.slice(Math.max(0, m.index - room), m.index + anchor.length + room)).includes(q)) return true;
    hits += 1;
    if (hits >= MAX_ANCHOR_HITS) return undefined;
  }
  return false;
}

/** A test for normalised quotes against one text; a small text is normalised once however many quotes are asked. */
function finder(text: string): (q: string) => Found {
  if (text.length > BIG_TEXT) return q => windowedIncludes(text, q);
  let normal: string | undefined;
  return q => (normal ??= normalizeQuote(text)).includes(q);
}

const both = (a: Found, b: () => Found): QuoteCheck => {
  if (a === true) return 'found';
  const second = b();
  return second === true ? 'found' : a === undefined || second === undefined ? 'unchecked' : 'missing';
};

export type QuoteCheck = 'found' | 'missing' | 'unchecked';

/** Looks for a quote in the visible text of a page, then in the text the page ships inside JSON. `unchecked`: the search gave up on a big page. */
export function searchHtml(html: string, quote: string): QuoteCheck {
  const q = normalizeQuote(quote);
  return both(finder(visibleText(html))(q), () => finder(unescapedHtml(html))(q));
}

export const quoteInHtml = (html: string, quote: string): boolean => searchHtml(html, quote) === 'found';

export const quoteInText = (text: string, quote: string): boolean => normalizeQuote(text).includes(normalizeQuote(quote));

export class EvidenceError extends Error {}

/** The page at `url` as text, or null when it cannot be read (blocked, login, timeout, not text). `finished` is false when the page was bigger than we read. */
async function readPage(url: string, fetcher: typeof fetch): Promise<{ html: string; finished: boolean } | null> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { 'user-agent': 'SpottedLondonBot/0.1 (+https://spotted.london/bot)', accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok || !/html|text/i.test(res.headers.get('content-type') ?? '') || !res.body) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let size = 0;
  let finished = false;
  while (size < MAX_HTML) {
    const { done, value } = await reader.read();
    if (done || !value) { finished = true; break; }
    html += decoder.decode(value, { stream: true });
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return { html, finished };
}

/**
 * Where the quote must be found. Posts Spotted fetched itself are checked against their stored
 * text. Other pages are fetched. A page that cannot be read (blocked, login, timeout) is
 * 'unchecked', and the admin sees that; a page that loads without the quote is refused.
 */
export async function checkEvidence(
  quote: string,
  url: string,
  post: { body: string | null } | null,
  fetcher: typeof fetch = fetch,
): Promise<EvidenceCheck> {
  if (post) {
    if (quoteInText(post.body ?? '', quote)) return 'found';
    throw new EvidenceError('The quote is not in that post. Copy it word for word from the post text.');
  }
  const target = safeUrl(url);
  if (!target) throw new EvidenceError('evidence_url must be a public web address.');
  const page = await readPage(target.toString(), fetcher);
  if (!page) return 'unchecked';
  const seen = searchHtml(page.html, quote);
  if (seen === 'found') return 'found';
  // A page bigger than we read (some site builders put the text far down) may have the quote past the cut.
  if (seen === 'unchecked' || !page.finished) return 'unchecked';
  throw new EvidenceError('The page loaded but the quote is not on it. Copy a sentence from the page word for word. If your tool summarises pages, fetch the raw page.');
}

/**
 * Several quotes against one page, fetched and read once (the Worker has about 10 ms of CPU, and the page text is the
 * expensive part). Unlike checkEvidence it never throws for a quote that is not there: each quote says `found`,
 * `missing` (the page loaded and does not have it) or `unchecked` (the page could not be read). Used for the tag
 * quotes, where one wrong quote must not stop the others or the draft.
 */
export async function checkQuotes(
  quotes: readonly string[],
  url: string,
  post: { body: string | null } | null,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, QuoteCheck>> {
  const out = new Map<string, QuoteCheck>();
  if (post) {
    const text = normalizeQuote(post.body ?? '');
    for (const q of quotes) out.set(q, text.includes(normalizeQuote(q)) ? 'found' : 'missing');
    return out;
  }
  const target = safeUrl(url);
  const page = target ? await readPage(target.toString(), fetcher) : null;
  if (!page) { for (const q of quotes) out.set(q, 'unchecked'); return out; }
  const inVisible = finder(visibleText(page.html));
  let inRaw: ((q: string) => Found) | null = null;
  for (const q of quotes) {
    const n = normalizeQuote(q);
    const seen = both(inVisible(n), () => (inRaw ??= finder(unescapedHtml(page.html)))(n));
    out.set(q, seen === 'missing' && !page.finished ? 'unchecked' : seen);
  }
  return out;
}

// Phrases that address an AI instead of describing a pop-up. A post that has one is never publish-ready:
// a person looks at it.
const AIMED_AT_AGENTS: readonly RegExp[] = [
  /\bignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages)\b/i,
  /\bdisregard (all |any |the )?(previous|prior|above|earlier)\b/i,
  /\b(system|developer) prompt\b/i,
  /\byou are (now )?(an? )?(ai|assistant|agent|language model|llm)\b/i,
  /\b(mark|set|label) (this|it|them|all|every)( pop-?ups?| posts?)? (as )?(verified|approved|valid|real|ready)\b/i,
  /<\/?(script|iframe|object|embed|img)\b/i,
  /\[\/?INST\]|<\|im_(start|end)\|>/i,
];

export const looksAimedAtAgents = (texts: readonly (string | null | undefined)[]): boolean =>
  texts.some(text => !!text && AIMED_AT_AGENTS.some(pattern => pattern.test(text)));
