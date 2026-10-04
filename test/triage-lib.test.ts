import { describe, expect, it } from 'vitest';
import { cutText, dateOnPage, differentSites, FixError, parseFixes, siteOf } from '../src/lib/triage';

describe('dateOnPage', () => {
  it.each([
    ['The show runs until 14 November 2026.', '2026-11-14'],
    ['Open 6 October to 14th Nov', '2026-11-14'],
    ['Closing Saturday, November 14', '2026-11-14'],
    ['14 of November', '2026-11-14'],
    ['Ends 14/11/2026', '2026-11-14'],
    ['Ends 14.11.26', '2026-11-14'],
    ['until 2026-11-14', '2026-11-14'],
    ['24 Sept to 19 December', '2026-09-24'],
    ['Thur 24 Sept – Sat 19 December 2026', '2026-12-19'],
    ['on the 5th of October', '2026-10-05'],
    ['The market runs 5 to 12 October', '2026-10-05'],
    ['The market runs 5 to 12 October', '2026-10-12'],
    ['Open 5-12 Oct', '2026-10-05'],
    ['Dates: 5 and 6 October', '2026-10-05'],
  ])('finds the date in %j', (quote, iso) => expect(dateOnPage(quote, iso)).toBe(true));

  it.each([
    ['The show runs until 15 November 2026.', '2026-11-14'],
    ['Open 4 November', '2026-11-14'],        // 4 is not 14
    ['114 November', '2026-11-14'],
    ['Open 14 October', '2026-11-14'],        // right day, wrong month
    ['nothing here', '2026-11-14'],
    ['14 November', 'not a date'],
    ['The market runs 5 to 12 October', '2026-10-06'],   // inside the range, not named
    ['The market runs 15 to 12 October', '2026-10-05'],  // 15 is not 5
    ['Open 5 to 12 October', '2026-11-05'],              // wrong month
  ])('does not find the date in %j', (quote, iso) => expect(dateOnPage(quote, iso)).toBe(false));
});

describe('siteOf and differentSites', () => {
  it('reduces a link to its site', () => {
    expect(siteOf('https://www.timeout.com/london/news/x')).toBe('timeout.com');
    expect(siteOf('https://news.example.co.uk/a')).toBe('example.co.uk');
    expect(siteOf('https://shop.brand.com/a')).toBe('brand.com');
    expect(siteOf('not a url')).toBeNull();
  });
  it('needs two different sites', () => {
    expect(differentSites(['https://a.com/1', 'https://www.a.com/2'])).toBe(false);
    expect(differentSites(['https://x.a.com/1', 'https://a.com/2'])).toBe(false);
    expect(differentSites(['https://a.com/1', 'https://b.com/2'])).toBe(true);
    expect(differentSites(['https://a.com/1'])).toBe(false);
    expect(differentSites([])).toBe(false);
  });
});

describe('cutText', () => {
  it('removes each piece once and tidies the spaces', () => {
    expect(cutText('A bar. Costumed staff serve drinks. Booking is advised.', [' Costumed staff serve drinks.']).text).toBe('A bar. Booking is advised.');
    expect(cutText('Open now , daily .', [' ,']).text).toBe('Open now daily.');
  });
  it('reports what was not there', () => {
    expect(cutText('Hello world, again.', ['moon', 'world']).missing).toEqual(['moon']);
  });
  it('removes only the first match', () => {
    expect(cutText('ab ab ab', ['ab']).text).toBe('ab ab');
  });
});

describe('parseFixes', () => {
  it('returns null when there is nothing to do', () => {
    expect(parseFixes(undefined)).toBeNull();
    expect(parseFixes(null)).toBeNull();
    expect(parseFixes({})).toBeNull();
    expect(parseFixes({ remove_text: [] })).toBeNull();
  });
  it('reads the three parts and trims', () => {
    expect(parseFixes({ remove_text: [' a piece '], clear: ['price_text'], set: { address: ' 1 High St ', end_date: '2026-11-14' } }))
      .toEqual({ remove_text: ['a piece'], clear: ['price_text'], set: { address: '1 High St', end_date: '2026-11-14' } });
  });
  it.each([
    [{ title: 'New' }, /no field title/],
    [{ set: { title: 'New' } }, /can change/],
    [{ set: { lat: '51' } }, /can change/],
    [{ clear: ['description'] }, /can only blank/],
    [{ remove_text: 'x' }, /list of strings/],
    [{ remove_text: Array(7).fill('x') }, /at most 6/],
    [{ set: { address: '' } }, /non-empty/],
    [[], /object/],
  ])('refuses %j', (raw, message) => {
    expect(() => parseFixes(raw)).toThrow(FixError);
    expect(() => parseFixes(raw)).toThrow(message);
  });
});
