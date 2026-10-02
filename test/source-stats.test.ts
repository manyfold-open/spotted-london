import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { sourceStats } from '../src/db/scout';

// D1 allows 100 bound parameters per query. The sources page asks for the stats of every source.
describe('sourceStats with many sources', () => {
  it('does not fail when there are more than 100 sources', async () => {
    const ids = Array.from({ length: 827 }, (_, i) => `many_src_${i}`);
    const stats = await sourceStats(env.DB, ids);
    expect(stats.size).toBe(0);
  });
});
