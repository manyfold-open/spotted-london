import { describe, expect, it } from 'vitest';
import { CLUSTER_MAX_ZOOM, clusterPins, clusterZoom, coreBounds, isAway, nearMeStart, nextSheetSize, pickSnap, pinSetKey } from '../web/src/lib/map-home';

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

describe('clusterPins', () => {
  // Soho, a few metres apart, and Greenwich, far away.
  const soho = [
    { id: 'a', lng: -0.1337, lat: 51.5136 },
    { id: 'b', lng: -0.1336, lat: 51.5137 },
    { id: 'c', lng: -0.1338, lat: 51.5135 },
  ];
  const far = { id: 'g', lng: -0.0098, lat: 51.4826 };

  it('folds pins that would touch into one bubble and leaves far ones alone', () => {
    const groups = clusterPins([...soho, far], 11);
    expect(groups).toHaveLength(2);
    const bubble = groups.find(g => g.members.length > 1)!;
    expect(bubble.members.sort()).toEqual(['a', 'b', 'c']);
    expect(bubble.key).toBe('c:a');
    expect(groups.find(g => g.members[0] === 'g')).toMatchObject({ key: 'g', members: ['g'] });
  });

  it('never folds the highlighted pin', () => {
    const groups = clusterPins([...soho, far], 11, 'b');
    expect(groups.find(g => g.key === 'b')?.members).toEqual(['b']);
    expect(groups.find(g => g.members.length > 1)?.members.sort()).toEqual(['a', 'c']);
  });

  it('puts every pin in exactly one group', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, lng: -0.2 + (i % 20) * 0.01, lat: 51.45 + Math.floor(i / 20) * 0.007 }));
    for (const z of [10, 12, 14, 16]) {
      const ids = clusterPins(many, z).flatMap(g => g.members).sort();
      expect(ids).toEqual(many.map(p => p.id).sort());
    }
  });

  it('spreads pins on one spot in a ring once it stops clustering', () => {
    const same = [{ id: 'x', lng: -0.07, lat: 51.52 }, { id: 'y', lng: -0.07, lat: 51.52 }, { id: 'z', lng: -0.07, lat: 51.52 }];
    const groups = clusterPins(same, CLUSTER_MAX_ZOOM);
    expect(groups.map(g => g.members.length)).toEqual([1, 1, 1]);
    const offs = groups.map(g => g.offset!.join(','));
    expect(new Set(offs).size).toBe(3);
    expect(clusterPins([same[0]], CLUSTER_MAX_ZOOM)[0].offset).toBeUndefined();
  });

  it('reclusters in half zoom steps', () => {
    expect(clusterZoom(12.2)).toBe(12);
    expect(clusterZoom(12.7)).toBe(12.5);
    expect(clusterZoom(19.3)).toBe(19);
  });

  it('rings pins that are a few metres apart around the first one', () => {
    const near = [{ id: 'm', lng: -0.1415, lat: 51.5103 }, { id: 'n', lng: -0.14145, lat: 51.51032 }];
    const [m, n] = clusterPins(near, CLUSTER_MAX_ZOOM);
    expect(m.offset).toBeDefined();
    expect(n.offset).toBeDefined();
  });
});

describe('coreBounds', () => {
  it('keeps every pin when there are only a few', () => {
    expect(coreBounds([{ lng: -0.1, lat: 51.5 }, { lng: -0.3, lat: 51.7 }])).toEqual([[-0.3, 51.5], [-0.1, 51.7]]);
    expect(coreBounds([])).toBeNull();
  });
  it('leaves out far-off pins once there are many', () => {
    const city = Array.from({ length: 40 }, (_, i) => ({ lng: -0.15 + i * 0.002, lat: 51.5 + i * 0.001 }));
    const [[w, s], [e, n]] = coreBounds([...city, { lng: -0.34, lat: 51.75 }, { lng: -0.19, lat: 51.15 }])!;
    expect(w).toBeGreaterThan(-0.2);
    expect(s).toBeGreaterThan(51.4);
    expect(n).toBeLessThan(51.6);
    expect(e).toBeLessThan(0);
  });
});

describe('nextSheetSize', () => {
  const a = { h: 600, peek: 400, half: 300 }, b = { h: 600, peek: 330, half: 300 };
  it('takes a new measurement', () => { expect(nextSheetSize(a, null, b)).toBe(b); });
  it('keeps the size when nothing changed', () => { expect(nextSheetSize(a, null, { ...a })).toBe(a); });
  it('keeps the size when the measurement goes back to the one just left (a flip-flop)', () => {
    expect(nextSheetSize(b, a, { ...a })).toBe(b);
  });
  it('still takes a size it has not just left', () => {
    expect(nextSheetSize(b, a, { h: 700, peek: 500, half: 350 })).toEqual({ h: 700, peek: 500, half: 350 });
  });
});
