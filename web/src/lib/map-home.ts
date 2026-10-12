// Pure decisions for the map home, kept out of React so they can be tested.

export type Snap = 'peek' | 'half' | 'full';

/** The three stops of the phone sheet, in px (see MapSheet). */
export interface SheetSize { h: number; peek: number; half: number }

const sameSize = (a: SheetSize | null, b: SheetSize) => !!a && a.h === b.h && a.peek === b.peek && a.half === b.half;

/**
 * Which size the sheet keeps after a new measurement. The sheet measures itself after every render, and what it
 * measures can depend on the size it has (a scrollbar, a wrapped line, safe-area padding), so two values can
 * undo each other for ever: React stops that with error 185 and the app shows its crash page. A measurement that
 * is the size just left (`prev`) is such a flip-flop: keep what we have, which ends it.
 */
export function nextSheetSize(cur: SheetSize, prev: SheetSize | null, next: SheetSize): SheetSize {
  if (sameSize(cur, next) || sameSize(prev, next)) return cur;
  return next;
}

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

/**
 * Which pins are on the map, as one string. The list is rebuilt every minute (and when your saves change) even
 * when nothing in it moved, so the map re-fits and re-centres only when this string changes.
 */
export function pinSetKey(items: readonly { id: string }[]): string {
  return items.map(p => p.id).sort().join(',');
}

/** The map counts as panned away from you when your dot is this far (px) from the visible centre. */
export function isAway(dx: number, dy: number, threshold = 70): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/** The browser's answer for geolocation, or 'unknown' when it has no Permissions API. */
export type GeoPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** What to do about location when the home page opens. */
export function nearMeStart(permission: GeoPermission, stored: '1' | '0' | null): 'auto' | 'prompt' | 'none' {
  if (permission === 'denied' || stored === '0') return 'none';
  if (permission === 'granted' && stored === '1') return 'auto';
  return 'prompt';
}

/** A pin to group: an id and where it is. */
export interface PinPoint { id: string; lng: number; lat: number }
/**
 * What the map draws for one spot: a single pin (one member) or a cluster bubble. `offset` (px) spreads out
 * pins that share one address, once the map is zoomed in too far to cluster them.
 */
export interface PinGroup { key: string; lng: number; lat: number; members: string[]; offset?: [number, number] }

/** Clusters stop at this zoom; past it every pin shows, fanned out where several share a spot. */
export const CLUSTER_MAX_ZOOM = 17;
/** Pins closer than this (screen px) join one cluster. A pin is 30 px, a bubble up to 48. */
export const CLUSTER_RADIUS = 44;

const project = (p: PinPoint, scale: number) => {
  const s = Math.sin((p.lat * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
};

/**
 * Groups pins that would overlap at this zoom, greedily in list order, like Supercluster. `keep` (the highlighted
 * pin) is never put in a cluster, so the card you are looking at always has its own pin.
 */
export function clusterPins(points: readonly PinPoint[], zoom: number, keep: string | null = null, radius = CLUSTER_RADIUS): PinGroup[] {
  const scale = 512 * 2 ** zoom; // MapLibre's world is 512 px wide at zoom 0, so `radius` is screen px
  const pts = points.map(p => ({ p, ...project(p, scale) }));
  const fan = zoom >= CLUSTER_MAX_ZOOM;
  const reach = fan ? 30 : radius; // fanned out: pins that would still touch (one pin wide) share a ring
  // Grid buckets of `reach` px, so each pin only looks at its neighbours.
  const cell = (v: number) => Math.floor(v / reach);
  const grid = new Map<string, number[]>();
  pts.forEach((q, i) => { const k = `${cell(q.x)},${cell(q.y)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  const used = new Uint8Array(pts.length);
  const out: PinGroup[] = [];
  pts.forEach((q, i) => {
    if (used[i]) return;
    used[i] = 1;
    const group = [i];
    if (q.p.id !== keep) {
      const cx = cell(q.x), cy = cell(q.y);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (used[j] || pts[j].p.id === keep) continue;
          if (Math.hypot(pts[j].x - q.x, pts[j].y - q.y) <= reach) { used[j] = 1; group.push(j); }
        }
      }
    }
    if (fan) {
      // Every pin shows; several on (almost) one spot sit in a ring around the first one.
      // Room for every pin (34 px each) around the circle, and never closer than 24 px to the middle.
      const r = Math.max(24, (group.length * 34) / (2 * Math.PI));
      group.forEach((j, n) => {
        const a = (n / group.length) * 2 * Math.PI - Math.PI / 2;
        const p = pts[j].p;
        // Offsets are from the first pin's spot, so the ring is round even when the pins are a few metres apart.
        const off: [number, number] = [Math.round(q.x + r * Math.cos(a) - pts[j].x), Math.round(q.y + r * Math.sin(a) - pts[j].y)];
        out.push({ key: p.id, lng: p.lng, lat: p.lat, members: [p.id], ...(group.length > 1 ? { offset: off } : {}) });
      });
      return;
    }
    const members = group.map(j => pts[j].p);
    const lng = members.reduce((s, p) => s + p.lng, 0) / members.length;
    const lat = members.reduce((s, p) => s + p.lat, 0) / members.length;
    out.push({ key: members.length === 1 ? q.p.id : `c:${q.p.id}`, lng, lat, members: members.map(p => p.id) });
  });
  return out;
}

/**
 * The zoom the map reclusters at: half steps, so a pinch does not regroup the pins on every frame. Past the last
 * cluster step it keeps going, because the fanned-out rings are worked out in pixels at that zoom.
 */
export const clusterZoom = (zoom: number) => Math.floor(zoom * 2) / 2;

/**
 * The box the map first shows: the middle 90% of pins on each axis once there are enough of them, so a few
 * far-out ones (St Albans, Gatwick) do not zoom the whole city out to one cluster. Those still show at the edge
 * or a pan away. [[west, south], [east, north]], or null with no pins.
 */
export function coreBounds(points: readonly { lng: number; lat: number }[], share = 0.9): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  const lngs = points.map(p => p.lng).sort((a, b) => a - b), lats = points.map(p => p.lat).sort((a, b) => a - b);
  const cut = points.length >= 20 ? Math.floor((points.length * (1 - share)) / 2) : 0;
  const last = points.length - 1 - cut;
  return [[lngs[cut], lats[cut]], [lngs[last], lats[last]]];
}
