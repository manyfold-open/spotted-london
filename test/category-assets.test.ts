import { describe, expect, it } from 'vitest';
import iconSource from '../web/src/components/Icon.tsx?raw';
import styles from '../web/src/styles.css?raw';
import { CATEGORIES } from '../src/shared/categories';

describe('every category has its look', () => {
  it.each([...CATEGORIES])('%s has an icon symbol', c => {
    expect(iconSource).toContain(`<symbol id="c-${c}" `);
  });

  it.each([...CATEGORIES])('%s has a cover pattern', c => {
    expect(styles).toMatch(new RegExp(`^\\.pat-${c} \\{`, 'm'));
  });

  it.each([...CATEGORIES])('%s has one colour, used by its pin and its cover', c => {
    expect(styles).toMatch(new RegExp(`--cc-${c}: #[0-9a-f]{6};`));
    expect(styles).toMatch(new RegExp(`\\.cc-${c} \\{ --cc: var\\(--cc-${c}\\) \\}`));
    expect(styles).toMatch(new RegExp(`^\\.pat-${c} \\{ background-color: color-mix\\(in srgb, var\\(--cc-${c}\\)`, 'm'));
  });

  it('has no symbol or pattern for a category that no longer exists', () => {
    const symbols = [...iconSource.matchAll(/<symbol id="c-([a-z]+)"/g)].map(m => m[1]);
    const patterns = [...styles.matchAll(/^\.pat-([a-z]+) \{/gm)].map(m => m[1]);
    expect(symbols.sort()).toEqual([...CATEGORIES].sort());
    expect(patterns.sort()).toEqual([...CATEGORIES].sort());
  });
});
