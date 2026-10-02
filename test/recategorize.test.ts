import { describe, expect, it } from 'vitest';
import { proposeCategory, updateSql, type Row } from '../src/lib/recategorize';

const row = (category: string, title: string, host: string | null = null, description: string | null = null): Row =>
  ({ id: `id_${title.length}`, category, title, host, description });

describe('proposing a category for an old row', () => {
  it('moves chef dinners from food to dining', () => {
    const p = proposeCategory(row('food', 'Archipelago with Marios Milios at Fig House, Dalston', 'table&candle with chef Marios Milios'));
    expect(p).toMatchObject({ from: 'food', to: 'dining', sure: true });
  });

  it('moves festival dinners to dining even without the word dinner', () => {
    expect(proposeCategory(row('food', 'Gourmet Odyssey Shoreditch', 'London Restaurant Festival')).to).toBe('dining');
  });

  it('does not treat a brand takeover as dining', () => {
    expect(proposeCategory(row('food', 'Gucci takeover at Selfridges')).to).not.toBe('dining');
    expect(proposeCategory(row('food', 'Kitchen takeover at Peckham Levels', 'Hot Stone')).to).toBe('dining');
  });

  it('moves street-food markets to market', () => {
    expect(proposeCategory(row('food', 'BANCARELLA Italian Street Food Market', 'We Love It CIC at Lower Stable Street Market')))
      .toMatchObject({ to: 'market', sure: true });
  });

  it('keeps real food as food', () => {
    expect(proposeCategory(row('food', 'Mooncake bakery'))).toMatchObject({ to: 'food', sure: true });
  });

  it('suggests event for a restaurant anniversary but is not sure', () => {
    expect(proposeCategory(row('food', 'Planque Turns 5', 'Planque'))).toMatchObject({ to: 'event', sure: false });
  });

  it('keeps food it knows nothing about as food and flags it', () => {
    expect(proposeCategory(row('food', 'Japan Matsuri 2026', 'The Japan Society'))).toMatchObject({ to: 'food', sure: false });
  });

  it('moves art fairs to market', () => {
    expect(proposeCategory(row('art', 'The Other Art Fair London', 'The Other Art Fair'))).toMatchObject({ to: 'market', sure: true });
  });

  it('moves museum lates to event', () => {
    expect(proposeCategory(row('art', 'Tate Modern Lates: 10th Birthday', 'Tate Modern'))).toMatchObject({ to: 'event', sure: true });
  });

  it('keeps one-off sculpture as art', () => {
    expect(proposeCategory(row('art', 'Frieze Sculpture 2026', 'Frieze and The Royal Parks'))).toMatchObject({ to: 'art', sure: true });
  });

  it('moves gallery shows to exhibition', () => {
    expect(proposeCategory(row('art', 'ArtEvol 2026: A View from Everywhere', 'London Art Collective at Saatchi Gallery')))
      .toMatchObject({ to: 'exhibition', sure: true });
  });

  it('falls back to exhibition and flags it when only the description gives a hint', () => {
    expect(proposeCategory(row('art', 'Reverence', 'Anna Blom', 'An exhibition of new paintings'))).toMatchObject({ to: 'exhibition', sure: false });
  });

  it('falls back to exhibition and flags it when there is no hint at all', () => {
    expect(proposeCategory(row('art', 'Create & Annoy', 'StolenSpace'))).toMatchObject({ to: 'exhibition', sure: false });
  });

  it('leaves other categories alone', () => {
    expect(proposeCategory(row('fashion', 'Sign of the Times Preloved Designer Sale'))).toMatchObject({ to: 'fashion', sure: true, why: 'unchanged' });
  });
});

describe('the SQL', () => {
  it('writes one guarded UPDATE per changed row and skips unchanged ones', () => {
    const sql = updateSql([
      { id: 'a1', from: 'food', to: 'dining', sure: true, why: 'x' },
      { id: 'b2', from: 'food', to: 'food', sure: true, why: 'x' },
    ]);
    expect(sql).toBe("UPDATE popups SET category = 'dining' WHERE id = 'a1' AND category = 'food';\n");
  });

  it('escapes quotes in ids', () => {
    expect(updateSql([{ id: "o'brien", from: 'art', to: 'event', sure: true, why: 'x' }])).toContain("WHERE id = 'o''brien'");
  });

  it('is empty when nothing changes', () => {
    expect(updateSql([])).toBe('');
  });
});
