import { describe, expect, it } from 'vitest';
import { emptyEvent, filterEvent, landingChannel, reasonWord, referrerHost, routeName, slugFromPath } from '../src/shared/tracking';

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
    expect(filterEvent({ saved: '1', when: 'all' }, '')).toEqual({ name: 'filter', detail: 'saved:1' }); // the Saved chip also widens the dates
    expect(filterEvent({ cat: null }, '')).toBeNull(); // clearing is not a use
    // a search counts once when it starts, with no detail, not for every letter
    expect(filterEvent({ q: 'denim' }, '')).toEqual({ name: 'search', detail: '' });
    expect(filterEvent({ q: 'denim jacket' }, 'denim')).toBeNull();
    expect(filterEvent({ q: '  ' }, '')).toBeNull();
    expect(JSON.stringify(filterEvent({ q: 'my secret search' }, ''))).not.toContain('secret');
  });

  it('reads the channel from campaign tags first', () => {
    expect(landingChannel('?utm_source=Instagram&utm_medium=social&utm_campaign=Autumn%20Pop-ups', '')).toEqual({ channel: 'instagram:social', campaign: 'autumn-pop-ups' });
    expect(landingChannel('?utm_source=newsletter', 'google.com')).toEqual({ channel: 'newsletter', campaign: '' });
    expect(landingChannel('?utm_source=share&utm_medium=link', '')).toEqual({ channel: 'share:link', campaign: '' });
  });

  it('counts a Google Ads click without keeping its code', () => {
    const c = landingChannel('?gclid=Cj0KCQiA-secret-click-code', 'google.com');
    expect(c).toEqual({ channel: 'google:cpc', campaign: '' });
    expect(JSON.stringify(c)).not.toContain('secret');
    expect(landingChannel('?gbraid=abc', '')?.channel).toBe('google:cpc');
  });

  it('falls back to the linking site, and says nothing for a direct visit', () => {
    expect(landingChannel('', 'google.com')).toEqual({ channel: 'google:organic', campaign: '' });
    expect(landingChannel('', 'google.co.uk')).toEqual({ channel: 'google:organic', campaign: '' });
    expect(landingChannel('', 'l.instagram.com')).toEqual({ channel: 'instagram:referral', campaign: '' });
    expect(landingChannel('', 'www.timeout.com')).toEqual({ channel: 'timeout:referral', campaign: '' });
    expect(landingChannel('', 'news.bbc.co.uk')).toEqual({ channel: 'bbc:referral', campaign: '' });
    expect(landingChannel('', '')).toBeNull();
    expect(landingChannel('?p=denim-night', '')).toBeNull();
  });

  it('never lets a tag be anything but a short fixed word', () => {
    const c = landingChannel('?utm_source=%3Cscript%3Ealert(1)%3C%2Fscript%3E&utm_medium=a%20b', '')!;
    expect(c.channel).toMatch(/^[a-z0-9_.-]+:[a-z0-9_.-]+$/);
    expect(landingChannel(`?utm_source=${'x'.repeat(200)}`, '')!.channel.length).toBe(30);
  });

  it('turns the sign-in sheet heading into a fixed reason', () => {
    expect(reasonWord('Sign in to vote')).toBe('vote');
    expect(reasonWord('Sign in to check in')).toBe('checkin');
    expect(reasonWord('Sign in to report')).toBe('report');
    expect(reasonWord('Sign in to save this')).toBe('save');
    expect(reasonWord('Sign in to add a pop-up')).toBe('add');
    expect(reasonWord('Sign in to do that')).toBe('other');
    expect(reasonWord('')).toBe('other');
  });

  it('names what an empty list was filtered by, and never the search text', () => {
    const base = { q: '', cat: '', verified: false, saved: false, when: 'week' };
    expect(emptyEvent({ ...base, q: 'my secret search' })).toEqual({ name: 'search_empty', detail: '' });
    expect(emptyEvent({ ...base, cat: 'food' })).toEqual({ name: 'filter_empty', detail: 'cat:food' });
    expect(emptyEvent({ ...base, when: 'today' })).toEqual({ name: 'filter_empty', detail: 'when:today' });
    expect(emptyEvent({ ...base, saved: true })).toEqual({ name: 'filter_empty', detail: 'saved:1' });
    expect(emptyEvent({ ...base, verified: true })).toEqual({ name: 'filter_empty', detail: 'verified:1' });
    expect(emptyEvent(base)).toBeNull(); // nothing filtered: an empty list is not a person's fault
    expect(JSON.stringify(emptyEvent({ ...base, q: 'my secret search' }))).not.toContain('secret');
  });
});
