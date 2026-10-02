// Pure decisions for the map home, kept out of React so they can be tested.

export type Snap = 'peek' | 'half' | 'full';

/** Where a dragged sheet settles. A fast flick adds 180 ms of travel at its release speed. */
export function pickSnap(y: number, velocity: number, heights: Record<Snap, number>): Snap {
  const landing = y + velocity * 180;
  let best: Snap = 'peek', gap = Infinity;
  for (const s of ['full', 'half', 'peek'] as const) {
    const d = Math.abs(heights[s] - landing);
    if (d < gap) { gap = d; best = s; }
  }
  return best;
}

/** The map counts as panned away from you when your dot is this far (px) from the visible centre. */
export function isAway(dx: number, dy: number, threshold = 70): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/** What to do about location when the home page opens. */
export function nearMeStart(permission: PermissionState | 'unknown', stored: '1' | '0' | null): 'auto' | 'prompt' | 'none' {
  if (permission === 'denied' || stored === '0') return 'none';
  if (permission === 'granted' && stored === '1') return 'auto';
  return 'prompt';
}
