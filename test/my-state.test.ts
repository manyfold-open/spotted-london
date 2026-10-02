import { describe, expect, it } from 'vitest';
import { mergeMe, patchState, type MyStateMap } from '../src/shared/my-state';

const base = (): MyStateMap => ({ saved: ['a'], votes: { a: { existence: 1, quality: -1 } } });

describe('your saves and votes over the public list', () => {
  it('adds me to every item, and returns the list untouched when there is no state', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    expect(mergeMe(items, undefined)).toBe(items);
    expect(mergeMe(items, null)).toBe(items);
    const merged = mergeMe(items, base());
    expect(merged[0].me).toEqual({ saved: true, existence_vote: 1, quality_vote: -1 });
    expect(merged[1].me).toEqual({ saved: false, existence_vote: 0, quality_vote: 0 });
  });

  it('saves and unsaves without touching votes or the old object', () => {
    const s = base();
    expect(patchState(s, 'b', { saved: true }).saved).toEqual(['a', 'b']);
    expect(patchState(s, 'a', { saved: true }).saved).toEqual(['a']);
    expect(patchState(s, 'a', { saved: false }).saved).toEqual([]);
    expect(patchState(s, 'b', { saved: true }).votes).toBe(s.votes);
    expect(s).toEqual(base());
  });

  it('a quality vote keeps the existence vote, and a first vote creates its entry', () => {
    expect(patchState(base(), 'a', { quality_vote: 1 }).votes.a).toEqual({ existence: 1, quality: 1 });
    expect(patchState(base(), 'a', { existence_vote: 0 }).votes.a).toEqual({ existence: 0, quality: -1 });
    expect(patchState(base(), 'b', { existence_vote: -1 }).votes.b).toEqual({ existence: -1, quality: 0 });
  });

  it('putting the previous state back is an undo', () => {
    const s = base();
    patchState(s, 'a', { saved: false, quality_vote: 1 });
    expect(s).toEqual(base());
  });
});
