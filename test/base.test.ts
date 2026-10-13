import { describe, expect, it } from 'vitest';
import { baseFrom, joinBase } from '../web/src/lib/base';

describe('where the page is mounted', () => {
  const doc = (content?: string) => ({ querySelector: () => (content === undefined ? null : { content }) }) as never;

  it('reads the prefix the Worker wrote, and is empty at a root', () => {
    expect(baseFrom(doc('/spotted-london'))).toBe('/spotted-london');
    expect(baseFrom(doc(''))).toBe('');
    expect(baseFrom(doc())).toBe('');
  });

  it('moves root paths under the mount and leaves everything else alone', () => {
    expect(joinBase('/spotted-london', '/api/v1/e')).toBe('/spotted-london/api/v1/e');
    expect(joinBase('/spotted-london', '/api/v1/images/a.jpg')).toBe('/spotted-london/api/v1/images/a.jpg');
    expect(joinBase('/spotted-london', '/')).toBe('/spotted-london/');
    expect(joinBase('/spotted-london', 'blob:https://app.test/1234')).toBe('blob:https://app.test/1234');
    expect(joinBase('/spotted-london', 'https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
    expect(joinBase('/spotted-london', '//cdn.example/a.jpg')).toBe('//cdn.example/a.jpg');
    expect(joinBase('/spotted-london', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('is safe to apply twice', () => {
    const once = joinBase('/spotted-london', '/assets/maps-1.js');
    expect(joinBase('/spotted-london', once)).toBe(once);
  });

  it('changes nothing at a root', () => {
    expect(joinBase('', '/api/v1/e')).toBe('/api/v1/e');
    expect(joinBase('', '/')).toBe('/');
  });
});
