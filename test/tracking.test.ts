import { describe, expect, it } from 'vitest';
import { filterEvent, referrerHost, routeName, slugFromPath } from '../src/shared/tracking';

describe('tracking helpers', () => {
  it('names a page with a fixed word and skips admin pages', () => {
    expect(routeName('/')).toBe('home');
    expect(routeName('/map')).toBe('home');
    expect(routeName('/p/denim-night')).toBe('popup');
    expect(routeName('/add')).toBe('add');
    expect(routeName('/saved/')).toBe('saved');
    expect(routeName('/something/else')).toBe('other');
    expect(routeName('/admin')).toBeNull();
    expect(routeName('/admin/insights')).toBeNull();
  });

  it('reads the slug from a shared link', () => {
    expect(slugFromPath('/p/denim-night')).toBe('denim-night');
    expect(slugFromPath('/p/denim-night/')).toBe('denim-night');
    expect(slugFromPath('/saved')).toBeNull();
    expect(slugFromPath('/p/%E0%A4%A')).toBeNull();
  });

  it('keeps only the site a visitor came from, and nothing for our own pages', () => {
    expect(referrerHost('https://www.google.com/search?q=popups+london', 'spotted.test')).toBe('google.com');
    expect(referrerHost('https://l.instagram.com/?u=x', 'spotted.test')).toBe('l.instagram.com');
    expect(referrerHost('https://spotted.test/p/x', 'spotted.test')).toBe('');
    expect(referrerHost('https://www.spotted.test/', 'spotted.test')).toBe('');
    expect(referrerHost('', 'spotted.test')).toBe('');
    expect(referrerHost('not a url', 'spotted.test')).toBe('');
  });

  it('counts a filter as one fixed word and never records what someone typed', () => {
    expect(filterEvent({ cat: 'food' }, '')).toEqual({ name: 'filter', detail: 'cat:food' });
    expect(filterEvent({ when: 'today' }, '')).toEqual({ name: 'filter', detail: 'when:today' });
    expect(filterEvent({ verified: '1' }, '')).toEqual({ name: 'filter', detail: 'verified:1' });
    expect(filterEvent({ cat: null }, '')).toBeNull(); // clearing is not a use
    // a search counts once when it starts, with no detail, not for every letter
    expect(filterEvent({ q: 'denim' }, '')).toEqual({ name: 'search', detail: '' });
    expect(filterEvent({ q: 'denim jacket' }, 'denim')).toBeNull();
    expect(filterEvent({ q: '  ' }, '')).toBeNull();
    expect(JSON.stringify(filterEvent({ q: 'my secret search' }, ''))).not.toContain('secret');
  });
});
