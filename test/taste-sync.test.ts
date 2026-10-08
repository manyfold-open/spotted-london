import { describe, expect, it } from 'vitest';
import { emptyTaste, learn, type Taste, type TasteItem } from '../src/shared/taste';
import { checkTasteBody, decideSync, freshMeta, hasAnswers, parseMeta, TASTE_MAX_BYTES, type SyncMeta } from '../src/shared/taste-sync';

const item = (category: string): TasteItem => ({ id: 'x', category, hot: 1, price: { type: 'paid' }, location: { borough: null }, start_at: 0, end_at: 1 });
const answered = (cat = 'food'): Taste => ({ ...learn(emptyTaste(), item(cat), true), on: true });
const meta = (o: Partial<SyncMeta> = {}): SyncMeta => ({ ...freshMeta(), ...o });
const server = (updated_at: number, taste: Taste = answered('art')) => ({ taste, updated_at });
const run = (o: { local?: Taste; meta?: SyncMeta; server?: ReturnType<typeof server> | null; uid?: string }) =>
  decideSync({ uid: o.uid ?? 'u1', local: o.local ?? emptyTaste(), meta: o.meta ?? freshMeta(), server: o.server === undefined ? null : o.server }).do;

describe('first sign in on a device (never linked)', () => {
  it('sends a taste made before signing in when the account has none', () => {
    expect(run({ local: answered() })).toBe('upload');
  });
  it('sends nothing when both are empty', () => {
    expect(run({})).toBe('none');
  });
  it('takes the account taste on a new device with nothing of its own', () => {
    expect(run({ server: server(500) })).toBe('adopt');
    expect(run({ local: { ...emptyTaste(), seen: true }, server: server(500) })).toBe('adopt');
  });
  it('when both have answers, the more recent change wins as a whole', () => {
    expect(run({ local: answered(), meta: meta({ at: 900 }), server: server(500) })).toBe('upload');
    expect(run({ local: answered(), meta: meta({ at: 100 }), server: server(500) })).toBe('adopt');
  });
  it('a local taste of unknown age (made before sync existed) loses to the account', () => {
    expect(run({ local: answered(), meta: meta({ at: 0 }), server: server(500) })).toBe('adopt');
  });
});

describe('a device that is linked to this account', () => {
  const linked = (o: Partial<SyncMeta> = {}) => meta({ uid: 'u1', base: 500, ...o });
  it('does nothing when neither side moved', () => {
    expect(run({ local: answered(), meta: linked(), server: server(500) })).toBe('none');
  });
  it('sends a local change when the account has not moved', () => {
    expect(run({ local: answered(), meta: linked({ dirty: true, at: 800 }), server: server(500) })).toBe('upload');
  });
  it('takes a change made on another device when there is nothing unsent here', () => {
    expect(run({ local: answered(), meta: linked(), server: server(700) })).toBe('adopt');
  });
  it('when both changed, the more recent change wins as a whole', () => {
    expect(run({ local: answered(), meta: linked({ dirty: true, at: 900 }), server: server(700) })).toBe('upload');
    expect(run({ local: answered(), meta: linked({ dirty: true, at: 600 }), server: server(700) })).toBe('adopt');
  });
  it('sends a cleared taste (Retake) rather than bringing the old one back', () => {
    expect(run({ local: { ...emptyTaste(), seen: true }, meta: linked({ dirty: true, at: 800 }), server: server(500) })).toBe('upload');
  });
  it('puts a taste back if the account copy is gone', () => {
    expect(run({ local: answered(), meta: linked(), server: null })).toBe('upload');
  });
});

describe('a shared browser', () => {
  it('drops a local taste that belongs to someone else, never sending it to this account', () => {
    expect(run({ uid: 'u2', local: answered(), meta: meta({ uid: 'u1', base: 500, dirty: true, at: 900 }), server: null })).toBe('drop_then_adopt');
    expect(run({ uid: 'u2', local: answered(), meta: meta({ uid: 'u1', base: 500 }), server: server(100) })).toBe('drop_then_adopt');
  });
});

describe('helpers', () => {
  it('hasAnswers', () => {
    expect(hasAnswers(emptyTaste())).toBe(false);
    expect(hasAnswers(answered())).toBe(true);
  });
  it('parseMeta reads anything odd as fresh', () => {
    for (const raw of [null, '', 'x', '[]', '5', '{"base":"a"}']) expect(parseMeta(raw)).toEqual(freshMeta());
    expect(parseMeta(JSON.stringify({ uid: 'u1', base: 5, dirty: true, at: 7, junk: 1 }))).toEqual({ uid: 'u1', base: 5, dirty: true, at: 7 });
    expect(parseMeta('{"base":-3,"at":null}')).toEqual(freshMeta());
  });
  it('checkTasteBody', () => {
    expect(checkTasteBody(answered()).ok).toBe(true);
    expect(checkTasteBody({ v: 2 }).ok).toBe(false);
    const big = checkTasteBody({ ...emptyTaste(), pad: 'x'.repeat(TASTE_MAX_BYTES) });
    expect(big).toMatchObject({ ok: false, code: 'taste_too_large' });
  });
});
