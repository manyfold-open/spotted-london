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
