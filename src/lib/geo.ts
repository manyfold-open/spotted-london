// Geohash + distance helpers. D1 has no PostGIS, so nearby lookups use
// a lat/lng box query and then exact distances in JS (SPEC §5.1).

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohash(lat: number, lng: number, precision = 7): string {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let hash = '', bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { ch |= 1 << (4 - bit); lngLo = mid; } else lngHi = mid;
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch |= 1 << (4 - bit); latLo = mid; } else latHi = mid;
    }
    even = !even;
    if (bit < 4) bit++;
    else { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

/** Great-circle distance in metres. */
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Bounding box that contains a circle of `radiusM` around a point. */
export function boxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

/** Rough Greater London bounds; anything outside is rejected. */
export const LONDON = { south: 51.28, north: 51.7, west: -0.52, east: 0.34 };

export function inLondon(lat: number, lng: number): boolean {
  return lat >= LONDON.south && lat <= LONDON.north && lng >= LONDON.west && lng <= LONDON.east;
}

export const CHECKIN_RADIUS_M = 200;
