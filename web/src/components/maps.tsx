// MapLibre + OpenFreeMap tiles (free, no API key). Loaded lazily; only map screens pay for it.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { AttributionControl, LngLatBounds, Map as MLMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Popup } from '../lib/api';
import { catIcon, isLive } from '../lib/format';
import { CLUSTER_MAX_ZOOM, clusterPins, clusterZoom, coreBounds, isAway, pinSetKey } from '../lib/map-home';
import { isPhone, reducedMotion } from '../lib/motion';
import type { IconName } from './Icon';

// MapLibre finds its worker relative to its own file, which breaks once bundled. Point it at
// the worker Vite builds for us instead.
setWorkerUrl(workerUrl);

/** Pins live outside React, so their icon is plain sprite markup. */
const iconMarkup = (name: IconName) => `<svg class="i" aria-hidden="true"><use href="#${name}"/></svg>`;

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LONDON: [number, number] = [-0.1276, 51.5072];
const LONDON_BOUNDS: [[number, number], [number, number]] = [[-0.52, 51.28], [0.34, 51.7]];

interface MapOptions { zoomButtons?: boolean; attribution?: 'bottom-right' | 'bottom-left' }

function newMap(el: HTMLElement, center = LONDON, zoom = 11.3, { zoomButtons = true, attribution = 'bottom-right' }: MapOptions = {}) {
  const map = new MLMap({ container: el, style: STYLE, center, zoom, maxBounds: [[-0.9, 51.1], [0.7, 51.9]], attributionControl: false });
  map.addControl(new AttributionControl({ compact: true }), attribution);
  // Start folded to its (i) button; opened it would run into the buttons on top of the map.
  const fold = () => {
    const credit = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    credit?.removeAttribute('open');
    credit?.classList.remove('maplibregl-compact-show');
  };
  fold();
  // MapLibre opens it by itself the first time a source reports its credit, which is often seconds before
  // 'load' while tiles arrive. These run after the control's own handlers, so they fold it straight back.
  const watch = () => {
    if (!map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')) return;
    fold();
    map.off('styledata', watch);
    map.off('sourcedata', watch);
  };
  map.on('styledata', watch);
  map.on('sourcedata', watch);
  map.once('load', fold);
  if (zoomButtons) map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  return map;
}

export interface PopupMapHandle { recenter(): void }
type Padding = { top: number; right: number; bottom: number; left: number };

/**
 * All pop-ups as pins, and you as a blue dot once you share your position. Tapping a pin calls onPin;
 * the highlighted one grows. `padding` keeps the middle of the map clear of the sheet or panel on top
 * of it. `onAway` says whether you have panned away from the dot.
 */
export const PopupMap = forwardRef<PopupMapHandle, {
  items: Popup[]; highlight: string | null; onPin: (p: Popup) => void;
  me: [number, number] | null; padding: Padding; onAway: (away: boolean) => void;
}>(function PopupMap({ items, highlight, onPin, me, padding, onAway }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  // Every pop-up has a pin, but only the ones not folded into a cluster are on the map (`on`).
  const markers = useRef(new Map<string, { m: Marker; el: HTMLButtonElement; look: string; on: boolean; off: string }>());
  const bubbles = useRef(new Map<string, { m: Marker; el: HTMLButtonElement; members: string[]; look: string }>());
  const dot = useRef<Marker | null>(null);
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const onAwayRef = useRef(onAway);
  onAwayRef.current = onAway;
  const meRef = useRef(me);
  meRef.current = me;
  const padRef = useRef(padding);
  padRef.current = padding;
  const fitted = useRef(false);
  const away = useRef(false);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Cluster bubble tapped: zoom until its pins have room. Pins that share one address fan out at the last step.
  const zoomInto = (ids: string[]) => {
    const m = map.current;
    if (!m) return;
    const want = new Set(ids), b = new LngLatBounds();
    for (const p of itemsRef.current) if (want.has(p.id)) b.extend([p.location.lng, p.location.lat]);
    if (b.isEmpty()) return;
    // The bar, chips and sheet are already the camera's padding; fitBounds adds this on top of it.
    m.fitBounds(b, { padding: 48, maxZoom: CLUSTER_MAX_ZOOM, duration: reducedMotion() ? 0 : 500 });
  };

  // 600+ pins on one city overlap into a blob you cannot tap. Pins that would touch become one bubble with a
  // count; this runs when the pins, the highlight or the zoom (in half steps) change.
  const zStep = useRef(-1);
  const regroup = useRef(() => {});
  regroup.current = () => {
    const m = map.current;
    if (!m) return;
    zStep.current = clusterZoom(m.getZoom());
    const groups = clusterPins(itemsRef.current.map(p => ({ id: p.id, lng: p.location.lng, lat: p.location.lat })), zStep.current, highlightRef.current);
    const shown = new Set<string>(), kept = new Set<string>();
    for (const g of groups) {
      if (g.members.length === 1) {
        const e = markers.current.get(g.members[0]);
        if (!e) continue;
        shown.add(g.members[0]);
        const off = g.offset ? g.offset.join(',') : '';
        if (e.off !== off) { e.off = off; e.m.setOffset(g.offset ?? [0, 0]); }
        if (!e.on) { e.m.addTo(m); e.on = true; }
        continue;
      }
      kept.add(g.key);
      let bub = bubbles.current.get(g.key);
      if (!bub) {
        const el = document.createElement('button');
        el.type = 'button';
        const made = { m: new Marker({ element: el }).setLngLat([g.lng, g.lat]).addTo(m), el, members: g.members, look: '' };
        el.addEventListener('click', e => { e.stopPropagation(); zoomInto(made.members); });
        bubbles.current.set(g.key, made);
        bub = made;
      }
      bub.members = g.members;
      bub.m.setLngLat([g.lng, g.lat]);
      const n = g.members.length, look = String(n);
      if (bub.look !== look) {
        bub.look = look;
        // Keep MapLibre's own class, as for pins. No `scale` here either: it would move the marker.
        bub.el.className = `maplibregl-marker pinc ${n >= 50 ? 'l' : n >= 10 ? 'm' : ''}`;
        bub.el.textContent = String(n);
        bub.el.setAttribute('aria-label', `${n} pop-ups here. Zoom in to see them`);
      }
    }
    for (const [id, e] of markers.current) if (e.on && !shown.has(id)) { e.m.remove(); e.on = false; }
    for (const [key, bub] of bubbles.current) if (!kept.has(key)) { bub.m.remove(); bubbles.current.delete(key); }
  };

  useEffect(() => {
    const phone = isPhone();
    const m = newMap(el.current!, LONDON, 11.3, { zoomButtons: !phone, attribution: phone ? 'bottom-left' : 'bottom-right' });
    map.current = m;
    // The chrome on top of the map is the camera's padding from the start, so every fitBounds below only adds
    // its own margin (MapLibre adds the two together; passing the chrome again zoomed far too far out).
    m.setPadding(padRef.current);
    // You are "away" when your dot is far from the middle of the part of the map you can see.
    const check = () => {
      const you = meRef.current;
      if (!you) return;
      const pt = m.project([you[1], you[0]]), pad = padRef.current, c = m.getCanvas();
      const cx = (pad.left + c.clientWidth - pad.right) / 2, cy = (pad.top + c.clientHeight - pad.bottom) / 2;
      const now = isAway(pt.x - cx, pt.y - cy);
      if (now !== away.current) { away.current = now; onAwayRef.current(now); }
    };
    m.on('move', check);
    m.on('moveend', check);
    m.on('zoom', () => { if (clusterZoom(m.getZoom()) !== zStep.current) regroup.current(); });
    const ms = markers.current, bs = bubbles.current;
    return () => { ms.clear(); bs.clear(); dot.current = null; m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
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
        // Not on the map yet: regroup() below adds it unless it is folded into a cluster.
        const mk = new Marker({ element: b }).setLngLat([p.location.lng, p.location.lat]);
        entry = { m: mk, el: b, look: '', on: false, off: '' };
        markers.current.set(p.id, entry);
      }
      // The list is rebuilt on every vote, save and clock tick: only touch a pin whose look changed, because
      // rewriting 600+ pins each time stalls a phone.
      const checked = p.status === 'community' && p.source_checked ? 'checked' : '';
      const live = isLive(p) ? 'live' : '';
      const look = `${p.category} ${p.status} ${checked} ${live}`;
      if (entry.look !== look) {
        entry.look = look;
        // New pins drop in one after another, but only the first few: 600 animations at once is the jank.
        const drop = fresh && added < 16;
        // Keep MapLibre's own class: it carries the position:absolute the marker transform relies on.
        entry.el.className = `maplibregl-marker pinm cc-${p.category} ${p.status} ${checked} ${live} ${drop ? 'in' : ''}`;
        entry.el.style.animationDelay = drop ? `${added * 25}ms` : '';
        entry.el.innerHTML = iconMarkup(catIcon(p.category)) + '<i class="pb"><svg class="i" aria-hidden="true"><use href="#i-check"/></svg></i>';
      }
      if (fresh) added++;
    }
    for (const [id, x] of markers.current) if (!seen.has(id)) { x.m.remove(); markers.current.delete(id); }
    regroup.current();
  }, [items]);

  // Your dot.
  useEffect(() => {
    const m = map.current!;
    if (!me) { dot.current?.remove(); dot.current = null; away.current = false; return; }
    if (!dot.current) {
      const d = document.createElement('div');
      d.className = 'mp-you';
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', 'You are here');
      d.innerHTML = '<i></i>';
      dot.current = new Marker({ element: d }).setLngLat([me[1], me[0]]).addTo(m);
    } else dot.current.setLngLat([me[1], me[0]]);
  }, [me]);

  // Fit the pins (and you) whenever the list changes or you first appear. The first fit is instant;
  // later ones glide so you can see where things went.
  const hasMe = !!me;
  // The list is rebuilt every minute with the same pins: only refit when the set of pins changes.
  const pinSet = useMemo(() => pinSetKey(items), [items]);
  useEffect(() => {
    const m = map.current!;
    const duration = fitted.current && !reducedMotion() ? (meRef.current ? 900 : 700) : 0;
    const you = meRef.current;
    if (items.length || you) {
      const b = new LngLatBounds();
      if (you) {
        // Fit the pins with you in the middle, so the map does not start out looking panned away from you.
        let dx = 0.004, dy = 0.003;
        for (const p of items) { dx = Math.max(dx, Math.abs(p.location.lng - you[1])); dy = Math.max(dy, Math.abs(p.location.lat - you[0])); }
        b.extend([you[1] - dx, you[0] - dy]);
        b.extend([you[1] + dx, you[0] + dy]);
      } else b.extend(coreBounds(items.map(p => p.location))!);
      m.fitBounds(b, { padding: 32, maxZoom: you ? 15 : 14, duration }); // 32: a pin at the edge stays whole
      fitted.current = true;
    } else {
      m.fitBounds(LONDON_BOUNDS, { duration });
    }
  }, [pinSet, hasMe]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sheet or panel moved: keep the middle of the map clear of it.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    // A glide already under way (a fit after new filters) would be stopped by this one, and setPadding stops it
    // too: let it land, then move the padding.
    const go = () => m.easeTo({ padding: padRef.current, duration: reducedMotion() ? 0 : 300 });
    if (!m.isMoving()) go();
    else { m.once('moveend', go); return () => { m.off('moveend', go); }; }
  }, [padding.top, padding.right, padding.bottom, padding.left]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ring is put back whenever pins are rebuilt; the map only glides when the highlight itself changes.
  useEffect(() => {
    for (const [id, x] of markers.current) x.el.classList.toggle('hl', id === highlight);
  }, [highlight, items]);
  useEffect(() => {
    regroup.current(); // the highlighted pin always stands on its own
    const h = highlight && itemsRef.current.find(p => p.id === highlight);
    if (h && map.current) map.current.easeTo({ center: [h.location.lng, h.location.lat], padding: padRef.current, duration: reducedMotion() ? 0 : 400 });
  }, [highlight]);

  useImperativeHandle(ref, () => ({
    recenter() {
      const m = map.current, you = meRef.current;
      if (!m || !you) return;
      m.easeTo({ center: [you[1], you[0]], zoom: Math.max(m.getZoom(), 14), padding: padRef.current, duration: reducedMotion() ? 0 : 700 });
    },
  }), []);

  return <div className="ml" ref={el} />;
});

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
    pin.className = 'pinm verified_admin cc-other';
    pin.style.setProperty('--cc', 'var(--accent)');
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
