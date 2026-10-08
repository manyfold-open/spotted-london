import { describe, expect, it } from 'vitest';
import { meanwhile, quickGuess } from '../src/shared/ask-quick';
import { emptyTaste, learn, tasteSummary, type Taste } from '../src/shared/taste';

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 13); // Thu 8 Oct 2026, 14:00 London
const SAT = Date.UTC(2026, 9, 10, 12);

function item(id: string, o: { category?: string; free?: boolean; borough?: string | null; start?: number; end?: number; hot?: number } = {}) {
  return {
    id, status: 'community', category: o.category ?? 'market', title: id, host: null, hot: o.hot ?? 1,
    price: { type: o.free ? 'free' : 'paid' }, location: { borough: o.borough ?? null, lat: 51.5, lng: -0.1 },
    start_at: o.start ?? SAT, end_at: o.end ?? SAT + 6 * HOUR,
  };
}

describe('quickGuess', () => {
  it('reads when, free, categories and a known area from the words', () => {
    expect(quickGuess('Something free and a bit weird this weekend near Shoreditch', ['Shoreditch', 'Soho']))
      .toEqual({ when: 'weekend', free: true, categories: [], borough: 'Shoreditch', tags: [], avoid: [] });
    expect(quickGuess('street food tonight', [])).toMatchObject({ when: 'today', categories: ['food'] });
    expect(quickGuess('an art exhibition or a market on Saturday', [])).toMatchObject({ when: 'weekend', categories: ['market', 'exhibition', 'art'] });
    expect(quickGuess('anything good', ['Soho'])).toEqual({ when: 'week', free: false, categories: [], borough: null, tags: [], avoid: [] });
  });

  it('reads the obvious tag words, and "indoors" or rain as avoiding outdoors', () => {
    expect(quickGuess('something with kids that is outdoors and late', []).tags).toEqual(['family', 'late_night', 'outdoors']);
    expect(quickGuess('vegan and interactive, a bit of live music', []).tags).toEqual(['vegan', 'interactive', 'live_music']);
    expect(quickGuess('it is raining, what is on', [])).toMatchObject({ tags: [], avoid: ['outdoors'] });
    expect(quickGuess('indoors please', []).avoid).toEqual(['outdoors']);
    expect(quickGuess('outdoors even if it rains', [])).toMatchObject({ tags: ['outdoors'], avoid: [] });
    expect(quickGuess('chocolate lateral thinking', []).tags).toEqual([]);
  });

  it('does not take part of a word for a category or an area', () => {
    expect(quickGuess('somewhere in Soho or farther', ['Soho', 'Far'])).toMatchObject({ borough: 'Soho' });
    expect(quickGuess('apartment party', []).categories).toEqual(['event']);
    expect(quickGuess('carts of marketing', []).categories).toEqual([]);
  });
});

describe('meanwhile', () => {
  const all = [
    item('a', { free: true, borough: 'Hackney', category: 'market', hot: 3 }),
    item('b', { free: true, borough: 'Soho', category: 'art', hot: 2 }),
    item('c', { free: false, borough: 'Hackney', category: 'food', hot: 5 }),
    item('d', { free: true, borough: 'Hackney', category: 'art', hot: 1 }),
    item('gone', { free: true, borough: 'Hackney', start: NOW - 3 * DAY, end: NOW - 2 * DAY, hot: 9 }),
  ];

  it('steers by the words in the question', () => {
    expect(meanwhile(all, 'free art this weekend', null, NOW).map(p => p.id)).toEqual(['b', 'd']);
    expect(meanwhile(all, 'free in Hackney', null, NOW).map(p => p.id)).toEqual(['a', 'd']);
  });

  it('relaxes the guess instead of coming back empty', () => {
    expect(meanwhile(all, 'free beauty in Soho', null, NOW).map(p => p.id)).toEqual(['a', 'b', 'd']);
    expect(meanwhile(all, 'free tech', null, NOW).map(p => p.id)).toEqual(['a', 'b', 'd']);
    expect(meanwhile(all, 'hello there', null, NOW).map(p => p.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(meanwhile([], 'anything', null, NOW)).toEqual([]);
  });

  it('filters by tag, avoids a tag, and falls back to an untagged list when little is tagged yet', () => {
    const tagged = [
      { ...item('t1', { category: 'market', hot: 3, free: true }), tags: ['family', 'outdoors'] },
      { ...item('t2', { category: 'market', hot: 2, free: true }), tags: ['family'] },
      { ...item('t3', { category: 'market', hot: 1, free: true }), tags: null },
    ];
    expect(meanwhile(tagged, 'something with kids', null, NOW).map(p => p.id)).toEqual(['t1', 't2']);
    expect(meanwhile(tagged, 'kids and outdoors', null, NOW).map(p => p.id)).toEqual(['t1']);
    expect(meanwhile(tagged, 'it is raining', null, NOW).map(p => p.id)).toEqual(['t2', 't3']);
    expect(meanwhile(tagged, 'vegan please', null, NOW).map(p => p.id)).toEqual(['t1', 't2', 't3']); // nothing is tagged vegan: the tag is dropped
  });

  it('keeps at most n and puts what the visitor likes first when For you is on', () => {
    expect(meanwhile(all, 'anything', null, NOW, 2)).toHaveLength(2);
    const two = [item('m', { category: 'market', hot: 2 }), item('r', { category: 'art', hot: 1.9 })];
    let t: Taste = { ...emptyTaste(), on: true };
    for (let i = 0; i < 3; i++) t = learn(t, item('x', { category: 'art' }) as never, true);
    expect(meanwhile(two, 'anything', t, NOW).map(p => p.id)).toEqual(['r', 'm']);
    expect(meanwhile(two, 'anything', { ...t, on: false }, NOW).map(p => p.id)).toEqual(['m', 'r']);
    expect(meanwhile(two, 'anything', null, NOW).map(p => p.id)).toEqual(['m', 'r']);
  });
});

describe('tasteSummary', () => {
  const like = (t: Taste, category: string, yes: boolean, free = false) => learn(t, item('x', { category, free }) as never, yes);

  it('is nothing until For you is on with answers behind it', () => {
    expect(tasteSummary(emptyTaste())).toBeNull();
    expect(tasteSummary(like({ ...emptyTaste(), on: false }, 'art', true))).toBeNull();
    expect(tasteSummary(like({ ...emptyTaste(), on: true }, 'art', true))).toMatchObject({ likes: ['art'] });
  });

  it('lists liked and left-out categories and says whether free entry is liked, and nothing more', () => {
    let t: Taste = { ...emptyTaste(), on: true };
    t = like(like(t, 'market', true, true), 'market', true, true);
    t = like(like(t, 'dining', false), 'dining', false);
    expect(tasteSummary(t)).toEqual({ likes: ['market'], left_out: ['dining'], free: 'likes' });
    const avoids = like(like({ ...emptyTaste(), on: true }, 'tech', false, true), 'tech', false, true);
    expect(tasteSummary(avoids)).toMatchObject({ free: 'avoids', left_out: ['tech'] });
    expect(Object.keys(tasteSummary(t)!).sort()).toEqual(['free', 'left_out', 'likes']);
  });
});
