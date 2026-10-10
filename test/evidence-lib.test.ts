import { describe, expect, it } from 'vitest';
import { checkEvidence, checkQuotes, EvidenceError, MAX_HTML, normalizeQuote, quoteInHtml, quoteInText, READ_TIMEOUT_MS, searchHtml } from '../src/lib/evidence';

describe('quoteInHtml', () => {
  it('ignores case, entities, smart quotes, dashes and whitespace', () => {
    const html = '<p>Open 5&ndash;12 Oct.\n  It&rsquo;s   free,</p><script>var hidden = "nope"</script>';
    expect(quoteInHtml(html, "open 5-12 oct. it's free,")).toBe(true);
    expect(quoteInHtml(html, 'Open 5–12 Oct. It’s free')).toBe(true);
  });
  it('does not match text the page never said', () => {
    expect(quoteInHtml('<p>Open 5 Oct</p><script>x()</script>', 'Open 6 Oct')).toBe(false);
  });
  it('finds text a page ships inside JSON', () => {
    expect(quoteInHtml('<script>{"d":"Runs 3 to 4 Oct \\u2013 King\'s Cross"}</script>', "Runs 3 to 4 Oct - King's Cross")).toBe(true);
  });
  it('closes a gap before punctuation left by removed tags', () => {
    expect(quoteInHtml('<p>Open <b>Friday</b>, 3 Oct</p>', 'Open Friday, 3 Oct')).toBe(true);
  });
});

describe('quoteInText', () => {
  it('matches post text', () => {
    expect(quoteInText('Pop-up this weekend!  3-4 Oct', 'this weekend! 3-4 oct')).toBe(true);
    expect(normalizeQuote('  A B ')).toBe('a b');
  });
});

describe('checkEvidence on big and slow pages', () => {
  const filler = (bytes: number) => '<p>' + 'x'.repeat(bytes) + '</p>';
  const serve = (html: string): typeof fetch => async () => new Response(html, { headers: { 'content-type': 'text/html' } });

  it('finds a quote far down a page of a megabyte or more', async () => {
    const html = filler(1_200_000) + '<p>04 Dec 2026, 19:00 - 22:30 Holtwhites</p>';
    expect(await checkEvidence('04 Dec 2026, 19:00 - 22:30 Holtwhites', 'https://wix.test/e', null, serve(html))).toBe('found');
  });
  it('says unchecked, not refused, when the page is bigger than it reads and the quote may lie past the cut', async () => {
    const html = filler(MAX_HTML + 100_000) + '<p>04 Dec 2026, 19:00</p>';
    expect(await checkEvidence('04 Dec 2026, 19:00', 'https://wix.test/e', null, serve(html))).toBe('unchecked');
  });
  it('still refuses a quote a page that fits does not have', async () => {
    await expect(checkEvidence('Open 6 Oct 2026', 'https://wix.test/e', null, serve(filler(1_200_000) + '<p>Open 5 Oct 2026</p>'))).rejects.toBeInstanceOf(EvidenceError);
  });
  it('matches in a big page as it does in a small one: tags, entities and runs of spaces in between', () => {
    const body = '<p>Open <b>Friday</b>,&nbsp;  3&ndash;4 Oct   at King&rsquo;s Cross</p>';
    const quote = "Open Friday, 3-4 Oct at King's Cross";
    expect(quoteInHtml(body, quote)).toBe(true);
    const big = filler(900_000) + body + filler(900_000);
    expect(quoteInHtml(big, quote)).toBe(true);
    expect(quoteInHtml(big, 'Open Saturday, 3-4 Oct at Kings Cross')).toBe(false);
  });
  it('falls back to the whole page for a quote with no plain word to look for', () => {
    expect(quoteInHtml(filler(900_000) + '<p>5 - 6 Oct</p>', '5 - 6 Oct')).toBe(true);
  });
  it('finds a quote on a big page when its anchor word comes up many times before it', () => {
    const many = '<p>opens soon</p>'.repeat(200);
    expect(quoteInHtml(filler(450_000) + many + '<p>The pop-up opens on 3 Oct</p>', 'The pop-up opens on 3 Oct')).toBe(true);
  });
  it('says unchecked, never missing, when the anchor word comes up too often to look at each place', async () => {
    const html = '<p>opens soon</p>'.repeat(40_000) + '<p>The pop-up opens on 3 Oct</p>';
    expect(searchHtml(html, 'The pop-up opens on 3 Oct')).toBe('unchecked');
    expect(await checkEvidence('The pop-up opens on 3 Oct', 'https://wix.test/e', null, serve(html))).toBe('unchecked');
    expect((await checkQuotes(['The pop-up opens on 3 Oct'], 'https://wix.test/e', null, serve(html))).get('The pop-up opens on 3 Oct')).toBe('unchecked');
  });
  it('still says missing for a quote a big page does not have, when it can look at every place', () => {
    expect(searchHtml(filler(900_000) + '<p>Open 5 Oct 2026</p>', 'Open 6 Oct 2026')).toBe('missing');
  });
  it('waits long enough for slow sites', () => {
    expect(READ_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000);
  });
});
