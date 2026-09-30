// MapLibre + OpenFreeMap tiles (free, no API key). Loaded lazily; only map screens pay for it.
import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MLMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Popup } from '../lib/api';
import { catIcon, isLive } from '../lib/format';
import { reducedMotion } from '../lib/motion';
import type { IconName } from './Icon';

// MapLibre finds its worker relative to its own file, which breaks once bundled. Point it at
// the worker Vite builds for us instead.
setWorkerUrl(workerUrl);

/** Pins live outside React, so their icon is plain sprite markup. */
const iconMarkup = (name: IconName) => `<svg class="i" aria-hidden="true"><use href="#${name}"/></svg>`;

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LONDON: [number, number] = [-0.1276, 51.5072];
const LONDON_BOUNDS: [[number, number], [number, number]] = [[-0.52, 51.28], [0.34, 51.7]];

function newMap(el: HTMLElement, center = LONDON, zoom = 11.3) {
  const map = new MLMap({ container: el, style: STYLE, center, zoom, maxBounds: [[-0.9, 51.1], [0.7, 51.9]], attributionControl: { compact: true } });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  return map;
}

/** All pop-ups as pins. Tapping a pin calls onPin; the highlighted one grows. */
export function PopupMap({ items, highlight, onPin }: { items: Popup[]; highlight: string | null; onPin: (p: Popup) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef(new Map<string, { m: Marker; el: HTMLButtonElement }>());
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const fitted = useRef(false);

  useEffect(() => {
    map.current = newMap(el.current!);
    const ms = markers.current;
    return () => { ms.clear(); map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current!;
    const seen = new Set<string>();
    let added = 0;
    for (const p of items) {
      seen.add(p.id);
      let entry = markers.current.get(p.id);
      const fresh = !entry;
      if (!entry) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', p.title);
        b.addEventListener('click', e => { e.stopPropagation(); onPinRef.current(p); });
        const mk = new Marker({ element: b }).setLngLat([p.location.lng, p.location.lat]).addTo(m);
        entry = { m: mk, el: b };
        markers.current.set(p.id, entry);
      }
      entry.el.className = `pinm ${p.status} ${isLive(p) ? 'live' : ''} ${fresh ? 'in' : ''}`;
      // New pins drop in one after another.
      entry.el.style.animationDelay = fresh ? `${Math.min(added++, 16) * 25}ms` : '';
      entry.el.innerHTML = iconMarkup(catIcon(p.category));
    }
    for (const [id, x] of markers.current) if (!seen.has(id)) { x.m.remove(); markers.current.delete(id); }
    // The first fit is instant; later ones (new filters) glide so you can see where things went.
    const duration = fitted.current && !reducedMotion() ? 700 : 0;
    if (items.length) {
      const b = new LngLatBounds();
      items.forEach(p => b.extend([p.location.lng, p.location.lat]));
      m.fitBounds(b, { padding: 60, maxZoom: 14, duration });
      fitted.current = true;
    } else {
      m.fitBounds(LONDON_BOUNDS, { duration });
    }
  }, [items]);

  useEffect(() => {
    for (const [id, x] of markers.current) x.el.classList.toggle('hl', id === highlight);
    const h = highlight && items.find(p => p.id === highlight);
    if (h && map.current) map.current.easeTo({ center: [h.location.lng, h.location.lat], duration: reducedMotion() ? 0 : 400 });
  }, [highlight, items]);

  return <div className="ml" ref={el} />;
}

/** One draggable pin for the Add form. */
export function PinPicker({ lat, lng, onMove }: { lat: number; lng: number; onMove: (lat: number, lng: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const marker = useRef<Marker | null>(null);
  const map = useRef<MLMap | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    const m = newMap(el.current!, [lng, lat], 15.5);
    const pin = document.createElement('div');
    pin.className = 'pinm verified_admin';
    pin.innerHTML = iconMarkup('i-pin');
    marker.current = new Marker({ element: pin, draggable: true }).setLngLat([lng, lat]).addTo(m);
    marker.current.on('dragend', () => { const p = marker.current!.getLngLat(); onMoveRef.current(p.lat, p.lng); });
    m.on('click', e => { marker.current!.setLngLat(e.lngLat); onMoveRef.current(e.lngLat.lat, e.lngLat.lng); });
    map.current = m;
    return () => { m.remove(); };
    // the map is created once; later moves are applied below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cur = marker.current?.getLngLat();
    if (!cur || (Math.abs(cur.lat - lat) < 1e-7 && Math.abs(cur.lng - lng) < 1e-7)) return;
    marker.current!.setLngLat([lng, lat]);
    map.current?.easeTo({ center: [lng, lat], duration: 300 });
  }, [lat, lng]);

  return <div className="minimap" ref={el} />;
}
