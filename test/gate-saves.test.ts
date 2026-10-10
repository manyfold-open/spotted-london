import { describe, expect, it } from 'vitest';
import { LOCAL_SAVES_MAX, parseSaves, withSave } from '../src/shared/local-saves';
import { GATE_FRESH_MS, parseGate } from '../src/shared/gate';

describe('saves kept on this device', () => {
  it('reads odd stored text as nothing, and keeps only good entries once each', () => {
    expect(parseSaves(null)).toEqual([]);
    expect(parseSaves('not json')).toEqual([]);
    expect(parseSaves('{"v":2,"saves":[]}')).toEqual([]);
    expect(parseSaves('{"v":1,"saves":"x"}')).toEqual([]);
    const got = parseSaves(JSON.stringify({ v: 1, saves: [{ id: 'a', at: 5 }, { id: 'a', at: 9 }, { id: 7 }, null, { id: '', at: 1 }, { id: 'b' }, { id: 'x'.repeat(65), at: 1 }] }));
    expect(got).toEqual([{ id: 'a', at: 5 }, { id: 'b', at: 0 }]);
  });

  it('saves and unsaves one pop-up, and saving twice changes nothing', () => {
    const one = withSave([], 'a', true, 10);
    expect(one).toEqual([{ id: 'a', at: 10 }]);
    expect(withSave(one, 'a', true, 99)).toEqual(one);
    expect(withSave(one, 'b', true, 11).map(s => s.id)).toEqual(['a', 'b']);
    expect(withSave(one, 'a', false, 12)).toEqual([]);
    expect(withSave(one, 'zzz', false, 12)).toEqual(one);
  });

  it('never grows past the cap: the oldest one goes', () => {
    let list = withSave([], 'first', true, 0);
    for (let i = 0; i < LOCAL_SAVES_MAX; i++) list = withSave(list, `p${i}`, true, i + 1);
    expect(list).toHaveLength(LOCAL_SAVES_MAX);
    expect(list.some(s => s.id === 'first')).toBe(false);
    expect(list.at(-1)!.id).toBe(`p${LOCAL_SAVES_MAX - 1}`);
  });
});

describe('what the sign-in sheet remembers', () => {
  const now = 1_000_000;
  const stored = (over: Record<string, unknown> = {}) => JSON.stringify({ at: now - 1000, why: 'Sign in to vote', then: 'vote', ...over });

  it('gives back a vote to finish, with the words around it', () => {
    const got = parseGate(stored({ intent: { type: 'quality', id: 'abc', value: -1 } }), now);
    expect(got).toEqual({ why: 'Sign in to vote', then: 'vote', intent: { type: 'quality', id: 'abc', value: -1 } });
  });

  it('drops an intent it does not know, and keeps the message', () => {
    expect(parseGate(stored({ intent: { type: 'delete_everything', id: 'abc', value: 1 } }), now)).toEqual({ why: 'Sign in to vote', then: 'vote' });
    expect(parseGate(stored({ intent: { type: 'quality', id: 'abc', value: 5 } }), now)).toEqual({ why: 'Sign in to vote', then: 'vote' });
    expect(parseGate(stored({ intent: { type: 'quality', id: 3, value: 1 } }), now)).toEqual({ why: 'Sign in to vote', then: 'vote' });
  });

  it('ignores anything old, from the future, missing or broken', () => {
    expect(parseGate(stored({ at: now - GATE_FRESH_MS - 1 }), now)).toBeNull();
    expect(parseGate(stored({ at: now + 5000 }), now)).toBeNull();
    expect(parseGate(JSON.stringify({ why: 'x' }), now)).toBeNull();
    expect(parseGate('{oops', now)).toBeNull();
    expect(parseGate(null, now)).toBeNull();
  });
});
