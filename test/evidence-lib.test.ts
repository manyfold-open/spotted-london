import { describe, expect, it } from 'vitest';
import { normalizeQuote, quoteInHtml, quoteInText } from '../src/lib/evidence';

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
