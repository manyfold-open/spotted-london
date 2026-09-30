import { describe, expect, it } from 'vitest';
import { londonDateString, parseLondonDate, windowFor } from '../src/lib/time';
import { geohash, haversine, inLondon } from '../src/lib/geo';
import { titleSimilarity } from '../src/lib/util';
import {
  emptyExtraction, finalise, fromLlm, guessCategory, mergeInto, parseJsonLdEvent, parseOpenGraph, readableText, safeUrl,
} from '../src/lib/extract';

const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London (BST)

describe('London time', () => {
  it('parses dates in BST and GMT correctly', () => {
    expect(parseLondonDate('2026-07-01')).toBe(Date.UTC(2026, 5, 30, 23));
    expect(parseLondonDate('2026-12-01')).toBe(Date.UTC(2026, 11, 1, 0));
    expect(parseLondonDate('2026-10-02T18:30')).toBe(Date.UTC(2026, 9, 2, 17, 30));
    expect(londonDateString(Date.UTC(2026, 5, 30, 23, 30))).toBe('2026-07-01');
  });

  it('builds the weekend window from Friday to Monday', () => {
    const w = windowFor('weekend', NOW);
    expect(w.from).toBe(Date.UTC(2026, 9, 1, 23)); // Fri 2 Oct 00:00 BST
    expect(w.to).toBe(Date.UTC(2026, 9, 4, 23)); // Mon 5 Oct 00:00 BST
  });

  it('starts the weekend now when it is already Saturday, across the clock change', () => {
    const sat = Date.UTC(2026, 9, 24, 11); // Sat 24 Oct 12:00 BST; clocks go back on Sun 25 Oct
    const w = windowFor('weekend', sat);
    expect(w.from).toBe(sat);
    expect(w.to).toBe(Date.UTC(2026, 9, 26, 0)); // Mon 26 Oct 00:00 GMT
  });

  it('ends "today" at London midnight', () => {
    expect(windowFor('today', NOW).to).toBe(Date.UTC(2026, 8, 30, 23));
  });
});

describe('geo', () => {
  it('encodes central London to the gcpv geohash cell', () => {
    expect(geohash(51.5074, -0.1278, 7).startsWith('gcpvj')).toBe(true);
  });
  it('measures distances and London bounds', () => {
    const soho = [51.5135, -0.134] as const, shoreditch = [51.5262, -0.078] as const;
    expect(haversine(...soho, ...shoreditch)).toBeGreaterThan(3800);
    expect(haversine(...soho, ...shoreditch)).toBeLessThan(4300);
    expect(inLondon(51.5, -0.12)).toBe(true);
    expect(inLondon(48.85, 2.35)).toBe(false);
  });
});

describe('duplicate titles', () => {
  it('matches the same pop-up under a slightly different name', () => {
    expect(titleSimilarity('Matcha Lab Pop-up', 'Matcha Lab Soho')).toBeGreaterThanOrEqual(0.8);
    expect(titleSimilarity('Matcha Lab Pop-up', 'Vintage Kilo Sale')).toBe(0);
  });
});

const EVENTBRITE = `<html><head>
<meta property="og:title" content="Autumn Flower Market &amp; Coffee">
<meta property="og:site_name" content="Eventbrite">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{
  "@type":"Event","name":"Autumn Flower Market","startDate":"2026-10-04T08:00:00+01:00","endDate":"2026-10-04T14:00:00+01:00",
  "organizer":{"@type":"Organization","name":"Bloom &amp; Stem"},
  "location":{"@type":"Place","name":"Columbia Road","address":{"streetAddress":"Columbia Road","addressLocality":"London","postalCode":"E2 7RG"}},
  "offers":{"@type":"Offer","price":"0","priceCurrency":"GBP"},
  "description":"Thirty growers selling dahlias and dried flowers."}]}</script>
</head><body><p>Hello</p><script>var x=1</script></body></html>`;

describe('link autofill parsing (SPEC 3.8)', () => {
  it('reads Event JSON-LD, including @graph, entities, times and free prices', () => {
    const e = parseJsonLdEvent(EVENTBRITE, NOW)!;
    expect(e.title).toBe('Autumn Flower Market');
    expect(e.host).toBe('Bloom & Stem');
    expect(e.address).toBe('Columbia Road, London, E2 7RG');
    expect(e.start_date).toBe('2026-10-04');
    expect(e.end_date).toBe('2026-10-04');
    expect(e.hours_text).toBe('08:00 to 14:00');
    expect(e.price_text).toBe('Free');
  });

  it('falls back to Open Graph and strips scripts from readable text', () => {
    expect(parseOpenGraph(EVENTBRITE).title).toBe('Autumn Flower Market & Coffee');
    expect(readableText(EVENTBRITE)).toBe('Hello');
  });

  it('keeps the first source per field, guesses a category and flags past dates', () => {
    const e = emptyExtraction();
    mergeInto(e, parseJsonLdEvent(EVENTBRITE, NOW), 'json_ld', 'high');
    mergeInto(e, parseOpenGraph(EVENTBRITE), 'og', 'check');
    finalise(e, '', NOW);
    expect(e.title).toBe('Autumn Flower Market');
    expect(e.confidence.title).toBe('high');
    expect(e.source).toEqual(['json_ld']);
    expect(e.category).toBe('market');
    expect(e.confidence.category).toBe('check');

    const old = emptyExtraction();
    mergeInto(old, { title: 'Old', start_date: '2026-01-01', end_date: '2026-01-02' }, 'llm_text', 'high');
    expect(finalise(old, '', NOW).confidence.end_date).toBe('check');
  });

  it('parses LLM output given as a string or an object', () => {
    const a = fromLlm('Sure! {"title":"Noodle Week","category":"Food","start_date":"2026-10-02","unsure":["end_date"]}');
    expect(a.fields.title).toBe('Noodle Week');
    expect(a.fields.category).toBe('food');
    expect(a.unsure).toEqual(['end_date']);
    expect(fromLlm({ title: '  ', category: 'sample sale' }).fields).toMatchObject({ title: null, category: 'sample' });
    expect(fromLlm('not json').fields.title).toBeNull();
  });

  it('guesses categories from words', () => {
    expect(guessCategory('Archive denim sample sale, up to 70% off')).toBe('sample');
    expect(guessCategory('Hand pulled noodles')).toBe('food');
  });

  it('only fetches public http(s) links', () => {
    expect(safeUrl('instagram.com/p/abc')?.hostname).toBe('instagram.com');
    expect(safeUrl('http://localhost:8787')).toBeNull();
    expect(safeUrl('http://10.0.0.1/admin')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('http://metadata.internal')).toBeNull();
  });
});
