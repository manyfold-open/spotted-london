// Evidence check (SPEC §13.4): a Scout draft carries a quote copied word for word from the page
// or post that states the facts. The server looks for that quote, so a draft cannot rest on text
// the page never said. Pure helpers here; the page fetch lives in checkEvidence().

import { decodeEntities as decodeBasic, safeUrl } from './extract';

const MORE: Record<string, string> = { ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', pound: '\u00a3' };
const decodeEntities = (s: string) => decodeBasic(s).replace(/&([a-z]+);/gi, (m, n: string) => MORE[n.toLowerCase()] ?? m);

export const EVIDENCE_MAX = 300;
export const EVIDENCE_MIN = 12;
const MAX_HTML = 600_000;

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

export function quoteInHtml(html: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  return normalizeQuote(visibleText(html)).includes(q) || normalizeQuote(unescapedHtml(html)).includes(q);
}

export const quoteInText = (text: string, quote: string): boolean => normalizeQuote(text).includes(normalizeQuote(quote));

export class EvidenceError extends Error {}

/** The page at `url` as text, or null when it cannot be read (blocked, login, timeout, not text). `finished` is false when the page was bigger than we read. */
async function readPage(url: string, fetcher: typeof fetch): Promise<{ html: string; finished: boolean } | null> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { 'user-agent': 'SpottedLondonBot/0.1 (+https://spotted.london/bot)', accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
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
  if (quoteInHtml(page.html, quote)) return 'found';
  // A page bigger than we read (some site builders put the text far down) may have the quote past the cut.
  if (!page.finished) return 'unchecked';
  throw new EvidenceError('The page loaded but the quote is not on it. Copy a sentence from the page word for word. If your tool summarises pages, fetch the raw page.');
}

export type QuoteCheck = 'found' | 'missing' | 'unchecked';

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
  const visible = normalizeQuote(visibleText(page.html));
  let raw: string | null = null;
  for (const q of quotes) {
    const n = normalizeQuote(q);
    if (visible.includes(n)) { out.set(q, 'found'); continue; }
    raw ??= normalizeQuote(unescapedHtml(page.html));
    out.set(q, raw.includes(n) ? 'found' : page.finished ? 'missing' : 'unchecked');
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
