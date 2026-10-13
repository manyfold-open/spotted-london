import { describe, expect, it } from 'vitest';
import { mergeCandidates, type MergeItem } from '../src/shared/merge-candidates';

const DAY = 86_400_000, T = Date.UTC(2026, 9, 14);
const item = (id: string, title: string, lat: number, lng: number, over: Partial<MergeItem> = {}): MergeItem =>
  ({ id, title, host: null, start_at: T, end_at: T + 10 * DAY, location: { lat, lng }, ...over });

const from = item('a', 'Gelupo x Maison Francois', 51.5135, -0.134);

describe('mergeCandidates', () => {
  it('suggests nearby pop-ups with overlapping dates, never the post itself', () => {
    const near = item('b', 'Summer flavour launch', 51.514, -0.1345);
    const far = item('c', 'Summer flavour launch', 51.6, -0.3);
    const later = item('d', 'Gelupo summer', 51.5136, -0.1341, { start_at: T + 30 * DAY, end_at: T + 40 * DAY });
    expect(mergeCandidates([from, near, far, later], from).map(p => p.id)).toEqual(['b']);
  });

  it('also suggests a far one that shares two words with the title', () => {
    const sameName = item('e', 'Maison Francois at Gelupo', 51.55, -0.2);
    expect(mergeCandidates([from, sameName], from).map(p => p.id)).toEqual(['e']);
  });

  it('puts the one with more words in common first', () => {
    const weak = item('f', 'Ice cream night', 51.5136, -0.1341);
    const strong = item('g', 'Gelupo Maison Francois', 51.5137, -0.1342);
    expect(mergeCandidates([from, weak, strong], from).map(p => p.id)).toEqual(['g', 'f']);
  });

  it('a typed search matches title or host anywhere, nearest first, at any dates', () => {
    const a = item('h', 'Kiln open day', 51.6, -0.3, { start_at: T + 90 * DAY, end_at: T + 91 * DAY });
    const b = item('i', 'Studio sale', 51.514, -0.135, { host: 'Kiln Collective' });
    expect(mergeCandidates([from, a, b], from, ' KILN ').map(p => p.id)).toEqual(['i', 'h']);
  });

  it('shows at most eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`m${i}`, 'Gelupo Francois', 51.5135 + i * 0.0001, -0.134));
    expect(mergeCandidates([from, ...many], from)).toHaveLength(8);
  });
});

import { duplicatePairs, pairKey, type PairItem } from '../src/shared/merge-candidates';

describe('duplicatePairs', () => {
  const p = (id: string, title: string, lat: number, lng: number, over: Partial<PairItem> = {}): PairItem => ({ ...item(id, title, lat, lng), category: 'art', ...over });

  it('finds the same pop-up listed twice and says why', () => {
    const a = p('a', 'Kiln Studio summer sale', 51.5412, -0.1011, { source_url: 'https://kiln.example/sale?utm=1' });
    const b = p('b', 'Summer sale at Kiln Studio', 51.5413, -0.1012, { source_url: 'http://www.kiln.example/sale/' });
    const [pair] = duplicatePairs([a, b]);
    expect(pair).toMatchObject({ key: 'a:b', keep: 'a' });
    expect(pair.why).toEqual(expect.arrayContaining(['same category', 'same source link']));
  });

  it('leaves out different dates, far apart, nothing in common, and anything dismissed', () => {
    const base = p('a', 'Kiln Studio summer sale', 51.5412, -0.1011);
    const later = p('b', 'Kiln Studio summer sale', 51.5412, -0.1011, { start_at: T + 30 * DAY, end_at: T + 31 * DAY });
    const far = p('c', 'Kiln Studio summer sale', 51.56, -0.1011);
    const other = p('d', 'Noodle night market', 51.5412, -0.1011);
    expect(duplicatePairs([base, later, far, other])).toEqual([]);
    const twin = p('e', 'Kiln Studio summer sale', 51.5412, -0.1011);
    expect(duplicatePairs([base, twin])).toHaveLength(1);
    expect(duplicatePairs([base, twin], new Set([pairKey('e', 'a')]))).toEqual([]);
  });

  it('a gallery with two different shows is not a pair (no shared word)', () => {
    expect(duplicatePairs([p('a', 'Renoir and Love', 51.5089, -0.1283), p('b', 'Sculpture garden weekend', 51.5089, -0.1283)])).toEqual([]);
  });

  it('keeps the more trusted one, then the one with more voters, then the older', () => {
    const a = p('a', 'Kiln Studio summer sale', 51.5412, -0.1011, { status: 'community', created_at: 2 });
    const b = p('b', 'Kiln Studio summer sale', 51.5412, -0.1011, { status: 'verified_admin', created_at: 3 });
    expect(duplicatePairs([a, b])[0].keep).toBe('b');
    const c = { ...a, id: 'c', verification: { voters: 4 } }, d = { ...a, id: 'd', created_at: 1 };
    expect(duplicatePairs([c, d])[0].keep).toBe('a'); // c (first) has the voters
    expect(duplicatePairs([{ ...a, id: 'x' }, { ...a, id: 'y', created_at: 1 }])[0].keep).toBe('b'); // y is older
  });

  it('does not count a word every market has', () => {
    expect(duplicatePairs([p('a', 'Summer night market', 51.5412, -0.1011), p('b', 'Winter night market sale', 51.5412, -0.1011)])).toEqual([]);
  });

  it('finds pairs in a grid of thousands without comparing them all', () => {
    const many = Array.from({ length: 3000 }, (_, i) => p(`n${i}`, `Stall${i} unique${i}`, 51.4 + (i % 60) * 0.004, -0.3 + Math.floor(i / 60) * 0.004));
    const t0 = Date.now();
    expect(duplicatePairs(many)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
