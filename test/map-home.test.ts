import { describe, expect, it } from 'vitest';
import { isAway, nearMeStart, pickSnap, pinSetKey } from '../web/src/lib/map-home';

const H = { peek: 434, half: 228, full: 0 };

describe('pickSnap', () => {
  it('snaps to the nearest offset when still', () => {
    expect(pickSnap(420, 0, H)).toBe('peek');
    expect(pickSnap(240, 0, H)).toBe('half');
    expect(pickSnap(20, 0, H)).toBe('full');
  });
  it('lets a fast flick carry it to the next snap', () => {
    expect(pickSnap(300, -1.2, H)).toBe('full'); // flicked up from between half and peek
    expect(pickSnap(120, 1.2, H)).toBe('peek'); // flicked down from between full and half
  });
});

describe('isAway', () => {
  it('is false near the centre and true beyond the threshold', () => {
    expect(isAway(10, 20)).toBe(false);
    expect(isAway(60, 60)).toBe(true);
  });
});

describe('nearMeStart', () => {
  it('locates silently only when allowed and used before', () => {
    expect(nearMeStart('granted', '1')).toBe('auto');
    expect(nearMeStart('granted', null)).toBe('prompt');
    expect(nearMeStart('prompt', '1')).toBe('prompt');
  });
  it('never asks again after Not now or a block', () => {
    expect(nearMeStart('prompt', '0')).toBe('none');
    expect(nearMeStart('denied', null)).toBe('none');
    expect(nearMeStart('denied', '1')).toBe('none');
  });
  it('asks when the Permissions API is missing and nothing is stored', () => {
    expect(nearMeStart('unknown', null)).toBe('prompt');
  });
});

describe('pinSetKey', () => {
  it('ignores order and rebuilt objects, but notices a pin added or removed', () => {
    const a = [{ id: 'x' }, { id: 'y' }];
    expect(pinSetKey([{ id: 'y' }, { id: 'x' }])).toBe(pinSetKey(a));
    expect(pinSetKey([...a, { id: 'z' }])).not.toBe(pinSetKey(a));
    expect(pinSetKey([])).toBe('');
  });
});
