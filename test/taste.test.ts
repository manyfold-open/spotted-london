import { describe, expect, it } from 'vitest';
import { ACTS_MAX, affinity, emptyTaste, forgetSwipes, forYou, hiddenCategories, learn, likedCategories, parseTaste, pickDeck, rate, setActs, syncActions, tasteSummary, type Taste, type TasteItem } from '../src/shared/taste';
import type { MyStateMap } from '../src/shared/my-state';
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

describe('learning from saves and votes', () => {
  const tallies = (t: Taste) => ({ cats: t.cats, boroughs: t.boroughs, free: t.free, swipes: t.swipes });

  it('counts a save as half a yes and a quality vote as a whole one, and leaves swipes alone', () => {
    const a = item('art'), b = item('food'), c = item('tech');
    expect(setActs(emptyTaste(), a, { saved: true }).cats.art).toEqual({ y: 0.5, n: 0 });
    expect(setActs(emptyTaste(), b, { quality: 1 }).cats.food).toEqual({ y: 1, n: 0 });
    expect(setActs(emptyTaste(), c, { quality: -1 }).cats.tech).toEqual({ y: 0, n: 1 });
    expect(setActs(emptyTaste(), a, { saved: true, quality: 1 }).swipes).toBe(0);
  });
  it('weighs a save below a swipe', () => {
    const a = item('art');
    expect(rate(setActs(emptyTaste(), a, { saved: true }).cats.art)).toBeLessThan(rate(learn(emptyTaste(), a, true).cats.art));
    expect(rate(setActs(emptyTaste(), a, { saved: true }).cats.art)).toBeGreaterThan(0.5);
  });
  it('adds a save and an up vote on the same pop-up, and the same category across pop-ups', () => {
    const a = item('art'), b = item('art');
    let t = setActs(emptyTaste(), a, { saved: true, quality: 1 });
    expect(t.cats.art).toEqual({ y: 1.5, n: 0 });
    t = setActs(t, b, { saved: true });
    expect(t.cats.art).toEqual({ y: 2, n: 0 });
  });

  it('never counts the same action twice', () => {
    const a = item('art', { price: { type: 'free' } });
    const once = setActs(emptyTaste(), a, { saved: true, quality: -1 });
    expect(setActs(once, a, { saved: true })).toBe(once);
    expect(setActs(once, a, { quality: -1 })).toBe(once);
    expect(setActs(setActs(once, a, { saved: true, quality: -1 }), a, { saved: true, quality: -1 })).toBe(once);
    expect(once.cats.art).toEqual({ y: 0.5, n: 1 });
    expect(once.free).toEqual({ y: 0.5, n: 1 });
    expect(once.boroughs.camden).toEqual({ y: 0.5, n: 1 });
  });
  it('undoes an unsave or a removed vote to exactly what it was before', () => {
    const a = item('art', { price: { type: 'free' } }), b = item('food');
    const base = learn(setActs(emptyTaste(), b, { saved: true }), item('fashion'), false);
    const withA = setActs(base, a, { saved: true, quality: 1 });
    expect(tallies(setActs(withA, a, { saved: false, quality: 0 }))).toEqual(tallies(base));
    expect(setActs(setActs(base, a, { saved: true }), a, { saved: false })).toEqual(base);
    expect(setActs(setActs(base, a, { quality: -1 }), a, { quality: 0 })).toEqual(base);
    expect(setActs(emptyTaste(), a, { saved: false })).toEqual(emptyTaste()); // nothing was counted, nothing to take back
  });
  it('undoes only the action that was undone', () => {
    const a = item('art');
    const both = setActs(emptyTaste(), a, { saved: true, quality: 1 });
    expect(setActs(both, a, { saved: false }).cats.art).toEqual({ y: 1, n: 0 });
    expect(setActs(both, a, { quality: 0 }).cats.art).toEqual({ y: 0.5, n: 0 });
  });
  it('turns a vote around without keeping the old side', () => {
    const a = item('art');
    let t = setActs(emptyTaste(), a, { quality: 1 });
    t = setActs(t, a, { quality: -1 });
    expect(t.cats.art).toEqual({ y: 0, n: 1 });
    t = setActs(t, a, { quality: 1 });
    expect(t.cats.art).toEqual({ y: 1, n: 0 });
  });
  it('toggling many times ends where the last state says', () => {
    const a = item('art');
    let t = emptyTaste();
    for (let i = 0; i < 7; i++) t = setActs(t, a, { saved: i % 2 === 0 });
    expect(t.cats.art).toEqual({ y: 0.5, n: 0 }); // the last one (i = 6) saved
    t = setActs(t, a, { saved: false });
    expect(t).toEqual(emptyTaste());
  });
  it('leaves swipe answers alone when an action is undone', () => {
    const a = item('art');
    let t = learn(emptyTaste(), a, true);
    t = setActs(t, a, { saved: true });
    expect(t.cats.art).toEqual({ y: 1.5, n: 0 });
    t = setActs(t, a, { saved: false });
    expect(t.cats.art).toEqual({ y: 1, n: 0 });
    expect(t.swipes).toBe(1);
  });
  it('takes back what was counted even if the pop-up has changed since', () => {
    const a = item('art', { location: { borough: 'Hackney' } });
    const t = setActs(emptyTaste(), a, { saved: true });
    const moved = { ...a, category: 'food', location: { borough: 'Camden' } };
    expect(setActs(t, moved, { saved: false })).toEqual(emptyTaste());
  });
  it('does not switch For you on or change the intro flags', () => {
    const a = item('art');
    const t = setActs(emptyTaste(), a, { saved: true, quality: 1 });
    expect([t.on, t.seen, t.swipes]).toEqual([false, false, 0]);
    const on = { ...emptyTaste(), on: true, seen: true, swipes: 4 };
    expect(setActs(on, a, { saved: true })).toMatchObject({ on: true, seen: true, swipes: 4 });
  });
  it('can hide a category with two down votes, and one up vote brings it back', () => {
    let t = setActs(setActs(emptyTaste(), item('fashion'), { quality: -1 }), item('fashion'), { quality: -1 });
    expect(hiddenCategories(t)).toEqual(['fashion']);
    t = setActs(t, item('fashion'), { quality: 1 });
    expect(hiddenCategories(t)).toEqual([]);
  });
  it('stops learning from new pop-ups past the limit instead of counting some twice', () => {
    let t = emptyTaste();
    t = { ...t, acts: Object.fromEntries([...Array(ACTS_MAX)].map((_, i) => [`x${i}`, { c: 'art', b: null, f: false, s: true as const }])) };
    const extra = item('food');
    expect(setActs(t, extra, { saved: true })).toBe(t);
    const known = { ...item('art'), id: 'x0' };
    expect(Object.keys(setActs(t, known, { saved: false }).acts)).toHaveLength(ACTS_MAX - 1);
  });
});

describe('syncActions', () => {
  const mineOf = (saved: string[], votes: Record<string, number> = {}): MyStateMap => ({ saved, votes: Object.fromEntries(Object.entries(votes).map(([id, quality]) => [id, { existence: 0, quality }])) });

  it('counts what someone already saved and voted before this existed, once', () => {
    const a = item('art'), b = item('food'), c = item('tech'), d = item('fashion');
    const mine = mineOf([a.id, b.id], { [b.id]: 1, [c.id]: -1, [d.id]: 0 });
    const t = syncActions(emptyTaste(), [a, b, c, d], mine);
    expect(t.cats).toEqual({ art: { y: 0.5, n: 0 }, food: { y: 1.5, n: 0 }, tech: { y: 0, n: 1 } });
    expect(t.swipes).toBe(0);
    expect(syncActions(t, [a, b, c, d], mine)).toBe(t); // again: no change, same object
    expect(syncActions(t, [d, c, b, a], mineOf([b.id, a.id], { [c.id]: -1, [b.id]: 1 }))).toBe(t);
  });
  it('counts what is new and takes back what is gone', () => {
    const a = item('art'), b = item('food');
    let t = syncActions(emptyTaste(), [a, b], mineOf([a.id]));
    t = syncActions(t, [a, b], mineOf([b.id], { [b.id]: 1 })); // unsaved a on another device, saved and liked b
    expect(t.cats).toEqual({ food: { y: 1.5, n: 0 } });
    expect(syncActions(t, [a, b], mineOf([]))).toEqual(syncActions(emptyTaste(), [a, b], mineOf([])));
  });
  it('does nothing while signed out or loading, so nothing counted is lost', () => {
    const a = item('art');
    const t = syncActions(emptyTaste(), [a], mineOf([a.id]));
    expect(syncActions(t, [a], undefined)).toBe(t);
    expect(syncActions(t, [a], null)).toBe(t);
  });
  it('leaves pop-ups alone that are not in the list any more', () => {
    const a = item('art');
    const t = syncActions(emptyTaste(), [a], mineOf([a.id]));
    expect(syncActions(t, [], mineOf([]))).toBe(t);
  });
  it('does not turn For you on, and does not use existence votes', () => {
    const a = item('art');
    const mine: MyStateMap = { saved: [], votes: { [a.id]: { existence: 1, quality: 0 } } };
    expect(syncActions(emptyTaste(), [a], mine)).toEqual(emptyTaste());
    expect(syncActions(emptyTaste(), [a], mineOf([a.id])).on).toBe(false);
  });
  it('sends nothing to Ask until For you is on with swipes behind it, and then only categories', () => {
    const a = item('art'), b = item('food');
    const t = syncActions(emptyTaste(), [a, b], mineOf([a.id], { [b.id]: -1 }));
    expect(tasteSummary(t)).toBeNull();
    expect(tasteSummary({ ...t, on: true })).toBeNull(); // still no swipes
    expect(tasteSummary({ ...t, on: true, swipes: 1 })).toEqual({ likes: ['art'], left_out: [], free: null });
  });
  it('gives the same taste in any order of events', () => {
    const a = item('art'), b = item('food');
    const viaClicks = setActs(setActs(setActs(emptyTaste(), a, { saved: true }), b, { quality: -1 }), a, { saved: false });
    const viaSync = syncActions(emptyTaste(), [a, b], mineOf([], { [b.id]: -1 }));
    expect(viaClicks).toEqual(viaSync);
  });
});

describe('forgetSwipes (Retake)', () => {
  it('drops every swipe but keeps what saves and votes are worth', () => {
    const a = item('art'), b = item('food');
    let t = learn(learn(emptyTaste(), b, true), item('fashion'), false);
    t = setActs(t, a, { saved: true, quality: 1 });
    t = { ...t, on: true };
    const f = forgetSwipes(t);
    expect(f.swipes).toBe(0);
    expect(f.cats).toEqual({ art: { y: 1.5, n: 0 } });
    expect(f).toMatchObject({ on: true, seen: true });
    expect(setActs(f, a, { saved: false, quality: 0 }).cats).toEqual({}); // and they can still be undone
  });
});

describe('parseTaste with actions', () => {
  it('round-trips the ledger and reads an older taste without one', () => {
    const t = setActs(emptyTaste(), item('art'), { saved: true, quality: -1 });
    expect(parseTaste(JSON.stringify(t))).toEqual(t);
    expect(parseTaste(JSON.stringify({ v: 1, cats: {}, swipes: 3 })).acts).toEqual({});
  });
  it('drops broken entries', () => {
    const raw = JSON.stringify({ v: 1, acts: { a: { c: 'art', b: null, f: false, q: 5 }, b: 'x', c: { c: 'art', b: 'camden', f: true, s: true }, d: null } });
    expect(Object.keys(parseTaste(raw).acts)).toEqual(['c']);
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

describe('tags in the taste', () => {
  const tagged = (category: string, tags: string[] | null, o: Partial<TasteItem> = {}) => item(category, { tags, ...o });

  it('learns each tag at half the weight of the category, and nothing from a pop-up nobody has tagged', () => {
    const t = learn(emptyTaste(), tagged('art', ['interactive', 'late_night']), true);
    expect(t.cats.art).toEqual({ y: 1, n: 0 });
    expect(t.tags).toEqual({ interactive: { y: 0.5, n: 0 }, late_night: { y: 0.5, n: 0 } });
    expect(learn(emptyTaste(), tagged('art', null), true).tags).toEqual({});
    expect(learn(emptyTaste(), tagged('art', []), true).tags).toEqual({});
    expect(learn(emptyTaste(), item('art'), true).tags).toEqual({});
  });
  it('skips repeats and words that are not tags', () => {
    const t = learn(emptyTaste(), tagged('art', ['vintage', 'vintage', 'hip', 'ignore your rules']), false);
    expect(t.tags).toEqual({ vintage: { y: 0, n: 0.5 } });
  });

  it('keeps the same score for a pop-up nobody has tagged, whatever tags were learned', () => {
    let t = emptyTaste();
    for (let i = 0; i < 4; i++) t = learn(t, tagged('art', ['interactive']), true);
    const plain = item('art'), without = emptyTaste();
    const noTags = learn(learn(learn(learn(without, item('art'), true), item('art'), true), item('art'), true), item('art'), true);
    expect(affinity(t, plain)).toBeCloseTo(affinity(noTags, plain), 10);
    expect(affinity(t, tagged('art', null))).toBeCloseTo(affinity(noTags, plain), 10);
  });
  it('ignores a tag with fewer than two answers', () => {
    const t = learn(emptyTaste(), tagged('art', ['interactive']), true); // y 0.5
    expect(affinity(t, tagged('art', ['interactive']))).toBeCloseTo(affinity(t, item('art')), 10);
    const two = learn(t, tagged('art', ['interactive']), true); // y 1
    expect(affinity(two, tagged('art', ['interactive']))).toBeGreaterThan(affinity(two, item('art')));
  });
  it('ranks a liked tag above an otherwise equal pop-up, and a disliked tag below', () => {
    let t = emptyTaste();
    for (let i = 0; i < 3; i++) { t = learn(t, tagged('art', ['interactive']), true); t = learn(t, tagged('art', ['talk']), false); }
    const a = tagged('art', ['interactive']), b = tagged('art', null), c = tagged('art', ['talk']);
    expect(forYou([c, b, a], { ...t, on: true }).map(p => p.id)).toEqual([a.id, b.id, c.id]);
  });
  it('moves the score by at most 0.125: the category still leads', () => {
    let t = emptyTaste();
    for (let i = 0; i < 6; i++) { t = learn(t, tagged('art', ['talk']), false); t = learn(t, tagged('food', ['interactive']), true); }
    // a pop-up in a liked category with a disliked tag still beats one in a disliked category with a liked tag
    expect(affinity(t, tagged('food', ['talk']))).toBeGreaterThan(affinity(t, tagged('art', ['interactive'])));
    for (const tags of [['interactive'], ['talk']]) expect(Math.abs(affinity(t, tagged('art', tags)) - affinity(t, item('art')))).toBeLessThanOrEqual(0.125);
  });
  it('never hides a pop-up because of a tag', () => {
    let t = emptyTaste();
    for (let i = 0; i < 8; i++) t = learn(t, tagged('art', ['talk']), false);
    t = learn(t, item('food'), true);
    const keep = tagged('food', ['talk']);
    expect(forYou([keep], { ...t, on: true }).map(p => p.id)).toEqual([keep.id]);
    expect(hiddenCategories(t)).toEqual(['art']);
  });

  it('counts the tags of a save the same way, and takes them back exactly', () => {
    const a = tagged('art', ['interactive', 'outdoors']), base = learn(emptyTaste(), item('food'), true);
    const saved = setActs(base, a, { saved: true, quality: 1 });
    expect(saved.tags).toEqual({ interactive: { y: 0.75, n: 0 }, outdoors: { y: 0.75, n: 0 } });
    expect(saved.acts[a.id].t).toEqual(['interactive', 'outdoors']);
    expect(setActs(saved, a, { saved: false, quality: 0 })).toEqual(base);
    // the tags it had when counted are what is taken back, even if the pop-up was retagged since
    const retagged = { ...a, tags: ['vintage'] };
    expect(setActs(saved, retagged, { saved: false, quality: 0 })).toEqual(base);
    expect(setActs(emptyTaste(), item('art'), { saved: true }).acts).toMatchObject({}); // an untagged act has no `t`
    expect(Object.values(setActs(emptyTaste(), tagged('art', null), { saved: true }).acts)[0]).not.toHaveProperty('t');
  });
  it('keeps what saves and votes taught, tags included, after Retake', () => {
    const a = tagged('art', ['interactive']);
    let t = learn(setActs(emptyTaste(), a, { saved: true }), tagged('food', ['talk']), true);
    const f = forgetSwipes({ ...t, on: true });
    expect(f.tags).toEqual({ interactive: { y: 0.25, n: 0 } });
  });

  it('reads an older taste with no tags, and keeps only tags on the list', () => {
    expect(parseTaste(JSON.stringify({ v: 1, cats: {}, swipes: 3 })).tags).toEqual({});
    const raw = JSON.stringify({ v: 1, tags: { family: { y: 2, n: 1 }, 'drop table': { y: 1, n: 1 }, outdoors: { y: -3, n: 'x' } } });
    expect(parseTaste(raw).tags).toEqual({ family: { y: 2, n: 1 }, outdoors: { y: 0, n: 0 } });
    const t = learn(emptyTaste(), tagged('art', ['family']), true);
    expect(parseTaste(JSON.stringify(t))).toEqual(t);
  });

  it('puts tags in the summary for Ask only with two answers and a clear lean, at most three each, as vocabulary keys', () => {
    let t: Taste = { ...emptyTaste(), on: true, swipes: 1 };
    t = learn(t, tagged('art', ['interactive']), true, 1, false);
    expect(tasteSummary(t)).not.toHaveProperty('tag_likes'); // one answer
    for (const tag of ['interactive', 'vintage', 'talk', 'makers', 'immersive']) { t = learn(t, tagged('art', [tag]), true, 1, false); t = learn(t, tagged('art', [tag]), true, 1, false); }
    for (const tag of ['outdoors', 'family']) { t = learn(t, tagged('food', [tag]), false, 1, false); t = learn(t, tagged('food', [tag]), false, 1, false); }
    const s = tasteSummary(t)!;
    expect(s.tag_likes).toHaveLength(3);
    expect(s.tag_likes!.every(k => ['interactive', 'vintage', 'talk', 'makers', 'immersive'].includes(k))).toBe(true);
    expect(s.tag_avoids).toEqual(['outdoors', 'family']);
    expect(Object.keys(s).sort()).toEqual(['free', 'left_out', 'likes', 'tag_avoids', 'tag_likes']);
  });
  it('can send a summary that is only tags', () => {
    let t: Taste = { ...emptyTaste(), on: true, swipes: 1 };
    for (let i = 0; i < 2; i++) t = learn(t, tagged('other', ['outdoors']), false, 1, false);
    // category "other" two noes: hidden, so left_out is set too; look at the tag part
    expect(tasteSummary(t)!.tag_avoids).toEqual(['outdoors']);
  });
});

describe('the deck shows tags it has not shown yet', () => {
  it('prefers, among cards of one category, the one with a new tag, and does not change a deck of untagged pop-ups', () => {
    const mk = (id: string, tags: string[] | null) => ({ ...item('market', { tags }), id });
    const items = [mk('a', ['outdoors']), mk('b', ['outdoors']), mk('c', ['vintage']), mk('d', ['outdoors', 'vintage'])];
    const deck = pickDeck(items, NOW, 3, () => 0.5);
    const shown = new Set(deck.flatMap(p => p.tags ?? []));
    expect(shown.has('outdoors') && shown.has('vintage')).toBe(true);
    const untagged = [mk('a', null), mk('b', null), mk('c', null)];
    expect(pickDeck(untagged, NOW, 3, () => 0.5).map(p => p.id)).toEqual(pickDeck(untagged.map(p => ({ ...p, tags: undefined })), NOW, 3, () => 0.5).map(p => p.id));
  });
});
