import { describe, expect, it } from 'vitest';
import { affinity, emptyTaste, forYou, hiddenCategories, learn, likedCategories, parseTaste, pickDeck, rate, type TasteItem } from '../src/shared/taste';
import { CATEGORIES } from '../src/shared/categories';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
let n = 0;
const item = (category: string, o: Partial<TasteItem> = {}): TasteItem => ({
  id: `p${String(++n).padStart(3, '0')}`, category, hot: 1, cover_url: null,
  price: { type: 'paid' }, location: { borough: 'Camden' }, start_at: NOW - DAY, end_at: NOW + 3 * DAY, ...o,
});

describe('learn and rate', () => {
  it('starts neutral and moves with each answer', () => {
    expect(rate(undefined)).toBe(0.5);
    const t = learn(emptyTaste(), item('food'), true);
    expect(rate(t.cats.food)).toBeCloseTo(2 / 3);
    expect(t.swipes).toBe(1);
    expect(learn(emptyTaste(), item('food'), false).cats.food).toEqual({ y: 0, n: 1 });
  });
  it('counts a soft signal by weight and leaves swipes alone', () => {
    const t = learn(emptyTaste(), item('art'), true, 0.5, false);
    expect(t.cats.art).toEqual({ y: 0.5, n: 0 });
    expect(t.swipes).toBe(0);
  });
  it('keeps free and area tallies', () => {
    const t = learn(emptyTaste(), item('food', { price: { type: 'free' }, location: { borough: ' Hackney ' } }), false);
    expect(t.free).toEqual({ y: 0, n: 1 });
    expect(t.boroughs.hackney).toEqual({ y: 0, n: 1 });
  });
  it('does not change the taste it was given', () => {
    const t = emptyTaste();
    learn(t, item('food'), true);
    expect(t.cats).toEqual({});
  });
});

describe('hidden and liked categories', () => {
  it('hides a category only after two noes and no yes', () => {
    let t = learn(emptyTaste(), item('fashion'), false);
    expect(hiddenCategories(t)).toEqual([]);
    t = learn(t, item('fashion'), false);
    expect(hiddenCategories(t)).toEqual(['fashion']);
    t = learn(t, item('fashion'), true);
    expect(hiddenCategories(t)).toEqual([]);
  });
  it('lists liked categories best first', () => {
    let t = emptyTaste();
    t = learn(t, item('art'), true);
    t = learn(t, item('food'), true);
    t = learn(t, item('food'), true);
    t = learn(t, item('tech'), false);
    expect(likedCategories(t)).toEqual(['food', 'art']);
  });
});

describe('forYou', () => {
  it('puts liked categories first and drops disliked ones', () => {
    let t = emptyTaste();
    t = learn(learn(t, item('food'), true), item('food'), true);
    t = learn(learn(t, item('fashion'), false), item('fashion'), false);
    const food = item('food', { hot: 0.5 }), art = item('art', { hot: 1 }), fashion = item('fashion', { hot: 3 });
    expect(forYou([art, fashion, food], t).map(p => p.id)).toEqual([food.id, art.id]);
  });
  it('keeps a disliked category when someone picked it themselves', () => {
    let t = learn(learn(emptyTaste(), item('fashion'), false), item('fashion'), false);
    const fashion = item('fashion');
    expect(forYou([fashion], t, true)).toEqual([fashion]);
  });
  it('lets a much hotter pop-up still win over a small liking', () => {
    const t = learn(emptyTaste(), item('food'), true);
    const food = item('food', { hot: 0 }), live = item('art', { hot: 4 });
    expect(forYou([food, live], t)[0]).toBe(live);
  });
  it('breaks ties by id and does not touch the input', () => {
    const a = item('art'), b = item('art');
    const input = [b, a];
    expect(forYou(input, emptyTaste()).map(p => p.id)).toEqual([a.id, b.id]);
    expect(input[0]).toBe(b);
  });
  it('uses free and area as small nudges', () => {
    let t = emptyTaste();
    t = learn(t, item('food', { price: { type: 'free' }, location: { borough: 'Hackney' } }), true);
    const near = item('art', { price: { type: 'free' }, location: { borough: 'Hackney' } }), far = item('art', { location: { borough: 'Camden' } });
    expect(affinity(t, near)).toBeGreaterThan(affinity(t, far));
  });
});

describe('parseTaste', () => {
  it('gives an empty taste for missing, broken or foreign data', () => {
    for (const raw of [null, '', '{', '[]', '{"v":2}', 'null']) expect(parseTaste(raw)).toEqual(emptyTaste());
  });
  it('round-trips and drops unknown categories and bad numbers', () => {
    const t = learn(emptyTaste(), item('food'), true);
    expect(parseTaste(JSON.stringify({ ...t, on: true, seen: true }))).toEqual({ ...t, on: true, seen: true });
    const odd = parseTaste(JSON.stringify({ v: 1, cats: { nonsense: { y: 5, n: 0 }, art: { y: -3, n: 'x' } }, swipes: 1e9 }));
    expect(odd.cats).toEqual({ art: { y: 0, n: 0 } });
    expect(odd.swipes).toBe(10_000);
  });
});

describe('pickDeck', () => {
  const seeded = () => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };
  const many = () => CATEGORIES.flatMap(c => [item(c, { cover_url: '/a.jpg' }), item(c), item(c, { price: { type: 'free' } })]);

  it('gives ten cards from ten different categories when it can', () => {
    const deck = pickDeck(many(), NOW, 10, seeded());
    expect(deck).toHaveLength(10);
    expect(new Set(deck.map(p => p.category)).size).toBe(10);
    expect(deck.map(p => p.category)).not.toContain('other'); // "other" is the last to be picked
  });
  it('is the same with the same random numbers', () => {
    const items = many();
    expect(pickDeck(items, NOW, 10, seeded()).map(p => p.id)).toEqual(pickDeck(items, NOW, 10, seeded()).map(p => p.id));
  });
  it('goes round again when there are few categories', () => {
    const items = [...Array(4)].map(() => item('food')).concat([...Array(4)].map(() => item('art')));
    const deck = pickDeck(items, NOW, 6, seeded());
    expect(deck).toHaveLength(6);
    expect(new Set(deck.map(p => p.id)).size).toBe(6);
  });
  it('skips ended pop-ups and ones far in the future, and handles an empty list', () => {
    const ended = item('food', { start_at: NOW - 5 * DAY, end_at: NOW - DAY }), later = item('art', { start_at: NOW + 60 * DAY, end_at: NOW + 61 * DAY });
    expect(pickDeck([ended, later], NOW)).toEqual([]);
    expect(pickDeck([], NOW)).toEqual([]);
  });
  it('prefers a pop-up with a photo within a category', () => {
    const bare = item('food'), photo = item('food', { cover_url: '/p.jpg' });
    for (let i = 0; i < 20; i++) expect(pickDeck([bare, photo], NOW, 1, seeded())[0]).toBe(photo);
  });
});
