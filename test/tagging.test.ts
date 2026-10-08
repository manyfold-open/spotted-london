import { describe, expect, it } from 'vitest';
import { CLAIM_CUES, quoteProblem, readTagChange, readTagQuotes, TagError } from '../src/lib/tagging';
import { checkQuotes } from '../src/lib/evidence';
import { mergeTags, vetClaimTags } from '../src/db/tags';
import { CLAIM_TAGS } from '../src/shared/tags';

describe('readTagQuotes', () => {
  it('reads claim tag quotes and leaves out the ones that need none', () => {
    expect(readTagQuotes([{ tag: 'Family', quote: ' Kids go free ' }, { tag: 'outdoors', quote: 'anything at all here' }, { tag: 'family', quote: 'second one' }]))
      .toEqual([{ tag: 'family', quote: 'Kids go free', url: null }]);
    expect(readTagQuotes(undefined)).toEqual([]);
  });
  it('refuses what is not a list of tag and quote', () => {
    expect(() => readTagQuotes('family')).toThrow(TagError);
    expect(() => readTagQuotes([{ tag: 'hip', quote: 'x' }])).toThrow(/not a tag/);
    expect(() => readTagQuotes(['family'])).toThrow(TagError);
    expect(() => readTagQuotes(Array.from({ length: 7 }, () => ({ tag: 'family', quote: 'x' })))).toThrow(TagError);
  });
});

describe('readTagChange', () => {
  it('reads add and remove, and a tag in both is left alone', () => {
    expect(readTagChange({ add: ['family', 'outdoors'], remove: ['outdoors', 'vintage'] })).toEqual({ add: ['family'], remove: ['vintage'], dropped: [] });
    expect(readTagChange({ add: [], remove: [] })).toEqual({ add: [], remove: [], dropped: [] });
    expect(readTagChange(undefined)).toBeNull();
  });
  it('reports words that are not tags and refuses other shapes', () => {
    expect(readTagChange({ add: ['trendy', 'outdoors'] })!.dropped).toEqual(['trendy']);
    expect(() => readTagChange(['outdoors'])).toThrow(TagError);
    expect(() => readTagChange({ set: [] })).toThrow(/no field set/);
    expect(() => readTagChange({ add: 'outdoors' })).toThrow(/list/);
  });
});

describe('claim cues', () => {
  const says: Record<string, [string[], string[]]> = {
    family: [['Kids go free', 'Family day with activities', 'All ages welcome', 'Under 12s free'], ['Open 5 to 11 October', 'Tickets £12']],
    adults_only: [['18+ only', 'Over 21s only', 'Adults only evening', 'Strictly over 18'], ['Open to everyone', 'Kids go free']],
    dog_friendly: [['Dogs are welcome', 'Bring your pup', 'Pet friendly'], ['Open daily', 'Free entry']],
    vegan: [['100% vegan menu', 'Plant-based canapes'], ['Street food stalls']],
    late_night: [['Open until 11pm', 'Doors 10pm to 2am', 'Open until midnight', '18:00 to 23:00', 'a late opening'], ['Open until 9pm', '10am to 6pm', '12:00 to 20:00']],
    booking_needed: [['Book a slot online', 'Tickets from £10', 'RSVP essential', 'Register on the website', 'pre-book your place'], ['Just turn up', 'Free entry for everyone']],
  };
  it('has a cue for every claim tag and none for the others', () => expect(Object.keys(CLAIM_CUES).sort()).toEqual([...CLAIM_TAGS].sort()));
  for (const [tag, [yes, no]] of Object.entries(says)) {
    it(`${tag}: accepts a quote that says it and refuses one that does not`, () => {
      for (const q of yes) expect(CLAIM_CUES[tag].test(q), q).toBe(true);
      for (const q of no) expect(CLAIM_CUES[tag].test(q), q).toBe(false);
    });
  }
  it('names the problem with a quote, or none', () => {
    expect(quoteProblem(undefined)).toMatch(/needs a quote/);
    expect(quoteProblem({ tag: 'family', quote: 'Kids go free', url: null })).toBeNull();
    expect(quoteProblem({ tag: 'family', quote: 'Kids', url: null })).toMatch(/12 to 300/);
    expect(quoteProblem({ tag: 'family', quote: 'The market runs 5 to 11 October', url: null })).toMatch(/does not say anything/);
  });
});

describe('mergeTags', () => {
  it('removes, then adds, then keeps five', () => {
    expect(mergeTags(['vintage', 'outdoors'], ['family'], ['vintage'])).toEqual({ next: ['outdoors', 'family'], over: [] });
    expect(mergeTags(['vintage'], ['vintage'], [])).toEqual({ next: ['vintage'], over: [] });
    expect(mergeTags(['immersive', 'interactive', 'live_music', 'shopping', 'tasting'], ['outdoors'], [])).toEqual({ next: ['immersive', 'interactive', 'live_music', 'shopping', 'tasting'], over: ['outdoors'] });
    expect(mergeTags(['immersive', 'interactive', 'live_music', 'shopping', 'tasting'], ['outdoors'], ['tasting']).next).toContain('outdoors');
  });
});

describe('checkQuotes', () => {
  const page = (html: string, type = 'text/html') => (async () => new Response(html, { headers: { 'content-type': type } })) as unknown as typeof fetch;
  it('reads the page once and says found or missing for each quote', async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response('<html><body><p>Kids go free.</p><script>Dogs welcome</script></body></html>', { headers: { 'content-type': 'text/html' } }); }) as unknown as typeof fetch;
    const r = await checkQuotes(['Kids go free', 'Dogs welcome here'], 'https://x.test/p', null, fetcher);
    expect(calls).toBe(1);
    expect(r.get('Kids go free')).toBe('found');
    expect(r.get('Dogs welcome here')).toBe('missing');
  });
  it('says unchecked when the page cannot be read, and checks a stored post as text', async () => {
    const down = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    expect((await checkQuotes(['Kids go free'], 'https://x.test/p', null, down)).get('Kids go free')).toBe('unchecked');
    expect((await checkQuotes(['Kids go free'], 'https://x.test/p', null, page('x', 'image/png'))).get('Kids go free')).toBe('unchecked');
    expect((await checkQuotes(['Kids go free'], 'not a url', null, page('x'))).get('Kids go free')).toBe('unchecked');
    const post = await checkQuotes(['kids  GO free', 'dogs'], 'https://instagram.com/p/1', { body: 'Kids go free all week' });
    expect(post.get('kids  GO free')).toBe('found');
    expect(post.get('dogs')).toBe('missing');
  });
});

describe('vetClaimTags', () => {
  it('keeps plain tags without a lookup, and a lookup that throws drops only the claim tags', async () => {
    let looked = 0;
    const lookup = async () => { looked++; throw new Error('boom'); };
    const r = await vetClaimTags(['outdoors', 'family'], [{ tag: 'family', quote: 'Kids go free here', url: null }], 'https://x.test/p', lookup);
    expect(r.kept).toEqual(['outdoors']);
    expect(r.dropped[0]).toMatchObject({ tag: 'family' });
    expect(looked).toBe(1);
    const none = await vetClaimTags(['outdoors', 'vintage'], [], null, lookup);
    expect(none.kept).toEqual(['outdoors', 'vintage']);
    expect(looked).toBe(1);
  });
});
