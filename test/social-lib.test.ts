import { describe, expect, it } from 'vitest';
import { buildInput, itemsUsd, MAX_ITEMS, parseItem, passesFilter, reserveUsd, socialMode, type SocialItem } from '../src/lib/social';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 12);

describe('socialMode', () => {
  it('reads Instagram accounts, hashtags and places', () => {
    expect(socialMode('https://www.instagram.com/coaldropsyard')).toMatchObject({ platform: 'instagram', kind: 'account', url: 'https://www.instagram.com/coaldropsyard/', label: 'Instagram account' });
    expect(socialMode('https://www.instagram.com/explore/tags/londonpopup')).toMatchObject({ platform: 'instagram', kind: 'tag', url: 'https://www.instagram.com/explore/tags/londonpopup/', label: 'Instagram hashtag' });
    expect(socialMode('https://www.instagram.com/explore/locations/213385402/london-england')).toMatchObject({ platform: 'instagram', kind: 'place', url: 'https://www.instagram.com/explore/locations/213385402/', label: 'Instagram place' });
  });

  it('reads Threads accounts and searches on both hosts', () => {
    expect(socialMode('https://www.threads.net/@boxpark')).toMatchObject({ platform: 'threads', kind: 'account', username: 'boxpark', label: 'Threads account' });
    expect(socialMode('https://www.threads.com/@boxpark')).toMatchObject({ platform: 'threads', kind: 'account', username: 'boxpark' });
    expect(socialMode('https://www.threads.net/search?q=london%20pop-up')).toMatchObject({ platform: 'threads', kind: 'search', query: 'london pop-up', label: 'Threads search' });
  });

  it('rejects addresses it cannot fetch', () => {
    for (const bad of [
      'https://www.tiktok.com/@brand', 'https://www.instagram.com/p/AbC123/', 'https://www.instagram.com/explore/',
      'https://www.instagram.com/reels/', 'https://www.threads.net/search', 'https://www.threads.net/@a/post/xyz',
      'https://www.instagram.com/login/', 'https://www.instagram.com/accounts/',
      'https://example.com/', 'not a url',
    ]) expect(socialMode(bad), bad).toBeNull();
  });
});

describe('buildInput', () => {
  it('builds the Instagram input for any of its three modes', () => {
    expect(buildInput(socialMode('https://www.instagram.com/coaldropsyard')!, 20, 4)).toEqual({
      resultsType: 'posts', directUrls: ['https://www.instagram.com/coaldropsyard/'], resultsLimit: 20, onlyPostsNewerThan: '4 days',
    });
    expect(buildInput(socialMode('https://www.instagram.com/explore/tags/londonpopup')!, 20, 4)).toEqual({
      resultsType: 'posts', directUrls: ['https://www.instagram.com/explore/tags/londonpopup/'], resultsLimit: 20, onlyPostsNewerThan: '4 days',
    });
    expect(buildInput(socialMode('https://www.instagram.com/explore/locations/213385402/london-england')!, 20, 4)).toEqual({
      resultsType: 'posts', directUrls: ['https://www.instagram.com/explore/locations/213385402/'], resultsLimit: 20, onlyPostsNewerThan: '4 days',
    });
  });

  it('builds the Threads inputs', () => {
    expect(buildInput(socialMode('https://www.threads.net/@boxpark')!, 20, 4)).toEqual({ mode: 'profile', profileUsernames: ['boxpark'], maxPosts: 20 });
    expect(buildInput(socialMode('https://www.threads.net/search?q=london%20pop-up')!, 20, 4)).toEqual({ mode: 'search', searchQuery: 'london pop-up', maxPosts: 20 });
  });
});

describe('parseItem', () => {
  it('reads an Instagram post and tidies its address', () => {
    const item = parseItem('instagram', {
      url: 'https://www.instagram.com/p/ABC/?igsh=zzz', caption: 'Jacquemus pop-up, 3 to 5 Oct', ownerUsername: 'jacquemus',
      timestamp: '2026-09-30T10:00:00.000Z', displayUrl: 'https://cdn.test/a.jpg', images: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
    });
    expect(item).toEqual({
      url: 'https://www.instagram.com/p/ABC', platform: 'instagram', author: 'jacquemus', body: 'Jacquemus pop-up, 3 to 5 Oct',
      image_urls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'], posted_at: Date.UTC(2026, 8, 30, 10),
    });
  });

  it('reads a Threads post with image objects', () => {
    const item = parseItem('threads', {
      url: 'https://www.threads.net/@boxpark/post/XYZ', username: 'boxpark', text: 'New pop-up opening Friday',
      posted_at: '2026-09-30T08:00:00Z', media_urls: [{ url: 'https://cdn.test/t.jpg' }, { url: 'http://insecure.test/x.jpg' }],
    });
    expect(item).toMatchObject({ platform: 'threads', author: 'boxpark', body: 'New pop-up opening Friday', image_urls: ['https://cdn.test/t.jpg'], posted_at: Date.UTC(2026, 8, 30, 8) });
  });

  it('turns Unix seconds into milliseconds', () => {
    expect(parseItem('threads', { url: 'https://www.threads.net/@a/post/1', text: 'pop-up', posted_at: 1790760000 })?.posted_at).toBe(1790760000 * 1000);
  });

  it('leaves video files out of the image list', () => {
    const item = parseItem('threads', {
      url: 'https://www.threads.net/@a/post/1', text: 'pop-up',
      media_urls: ['https://cdn.test/clip.mp4?_nc_cat=106&sig=abc', 'https://cdn.test/pic.jpg?_nc_cat=1', 'https://cdn.test/other.MOV'],
    });
    expect(item?.image_urls).toEqual(['https://cdn.test/pic.jpg?_nc_cat=1']);
  });

  it('keeps at most four images', () => {
    const images = Array.from({ length: 6 }, (_, i) => `https://cdn.test/${i}.jpg`);
    expect(parseItem('instagram', { url: 'https://www.instagram.com/p/A', caption: 'x', images })?.image_urls).toHaveLength(4);
  });

  it('returns null for items it cannot use', () => {
    expect(parseItem('instagram', { caption: 'no address' })).toBeNull();
    expect(parseItem('instagram', { url: 'not a url', caption: 'x' })).toBeNull();
    expect(parseItem('threads', null)).toBeNull();
    expect(parseItem('threads', 'text')).toBeNull();
  });
});

describe('passesFilter', () => {
  const post = (body: string, posted_at: number | null = NOW - DAY): SocialItem =>
    ({ url: 'https://www.instagram.com/p/X', platform: 'instagram', author: 'a', body, image_urls: [], posted_at });

  it('keeps pop-up talk in English and Chinese', () => {
    for (const t of ['Our pop-up opens Friday', 'POPUP at Coal Drops Yard', 'pop up shop', '#londonpopup', '#popupshop', 'Sample sale this weekend', 'Grand opening in Soho', 'Launch party', 'Summer residency', 'Limited time only', '倫敦快閃店', '伦敦快闪', '限時開幕', '开幕活动'])
      expect(passesFilter(post(t), NOW), t).toBe(true);
  });

  it('drops posts with no pop-up talk', () => {
    expect(passesFilter(post('Good morning London, coffee time'), NOW)).toBe(false);
    expect(passesFilter(post(''), NOW)).toBe(false);
  });

  it('drops posts older than 14 days but keeps undated ones', () => {
    expect(passesFilter(post('pop-up', NOW - 15 * DAY), NOW)).toBe(false);
    expect(passesFilter(post('pop-up', NOW - 13 * DAY), NOW)).toBe(true);
    expect(passesFilter(post('pop-up', null), NOW)).toBe(true);
  });

  it('drops posts about another UK city unless they also say London', () => {
    expect(passesFilter(post('Pop-up in Manchester this week'), NOW)).toBe(false);
    expect(passesFilter(post('After Manchester, our pop-up lands in London'), NOW)).toBe(true);
    expect(passesFilter(post('Paris label pop-up in Soho'), NOW)).toBe(true);
    expect(passesFilter(post('Pop-up in Paris this week'), NOW)).toBe(true);
  });
});

describe('cost', () => {
  it('prices a worst-case run and fetched items per platform', () => {
    expect(MAX_ITEMS).toBe(20);
    expect(reserveUsd('instagram')).toBeCloseTo(0.054);
    expect(reserveUsd('threads')).toBeCloseTo(0.04);
    expect(itemsUsd('threads', 10)).toBeCloseTo(0.02);
    expect(itemsUsd('instagram', 0)).toBe(0);
  });
});
