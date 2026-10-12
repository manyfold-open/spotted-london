import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { referrerHost, routeName, slugFromPath } from '../../../src/shared/tracking';

// Anonymous usage stats. What is sent and why is on the privacy page (src/privacy.ts); keep both in step.
//  - A random id made on this device (`spotted.vid`). It is never linked to an account, an email or an address.
//  - Nothing you type is sent, only fixed words (a page, a category, a filter) and the slug of a public pop-up.
//  - Off for admins, in dev, and when the browser says Do Not Track or Global Privacy Control, or the Me page switch is off.

export type TrackName =
  | 'view' | 'popup_open' | 'save' | 'vote' | 'checkin' | 'report' | 'share' | 'outbound' | 'filter' | 'search'
  | 'ask_send' | 'signin_start' | 'signin_done' | 'submit_done' | 'pwa_install';
export interface TrackFields { route?: string; slug?: string; detail?: string; x?: number; ref?: string }

const VID = 'spotted.vid';
const OFF = 'spotted.notrack';
const SIGNIN = 'spotted.signin';
const VISIT = 'spotted.visit';
const SIGNIN_WINDOW = 60 * 60_000;

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private window: carry on */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

type Navigator2 = Navigator & { globalPrivacyControl?: boolean };

/** True when this browser asked not to be counted, or the person switched it off on the Me page. */
export function trackingOptedOut(): boolean {
  const n = navigator as Navigator2;
  return n.doNotTrack === '1' || n.globalPrivacyControl === true || store.get(OFF) === '1';
}
export function setTrackingOptOut(off: boolean) {
  if (off) { store.set(OFF, '1'); queue.length = 0; } else store.del(OFF);
}

let memoryId: string | null = null;
function visitorId(): string {
  if (memoryId) return memoryId;
  const saved = store.get(VID);
  if (saved && /^[A-Za-z0-9]{8,32}$/.test(saved)) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
  store.set(VID, id);
  if (store.get(VID) !== id) memoryId = id; // no storage: one id for this page load only
  return id;
}

let ctx: { ready: boolean; signedIn: boolean; admin: boolean } = { ready: false, signedIn: false, admin: false };
const queue: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;

function enabled() { return import.meta.env.PROD && !ctx.admin && !trackingOptedOut(); }

function flush(force = false) {
  clearTimeout(timer); timer = undefined;
  if (!queue.length || (!ctx.ready && !force)) return;
  if (!enabled()) { queue.length = 0; return; }
  const body = JSON.stringify({ v: visitorId(), s: ctx.signedIn ? 1 : 0, w: innerWidth < 900 ? 'm' : 'd', events: queue.splice(0, 10) });
  try {
    if (!navigator.sendBeacon?.('/api/v1/e', new Blob([body], { type: 'application/json' }))) {
      void fetch('/api/v1/e', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
    }
  } catch { /* stats must never get in the way */ }
  if (queue.length) timer = setTimeout(flush, 500);
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  addEventListener('pagehide', () => flush(true));
  addEventListener('appinstalled', () => track('pwa_install'));
}

export function track(name: TrackName, f: TrackFields = {}) {
  if (!import.meta.env.PROD || ctx.admin || trackingOptedOut()) return;
  install();
  queue.push({ e: name, r: f.route, p: f.slug, d: f.detail, x: f.x, f: f.ref });
  if (queue.length > 30) queue.shift();
  // Wait up to 5 seconds for the account to load, so admins are not counted
  timer ??= setTimeout(() => flush(true), ctx.ready ? 1500 : 5000);
}

/** Shell tells us who is looking (only whether signed in, and whether admin) once the account has loaded. */
export function setTrackingContext(next: { signedIn: boolean; admin: boolean }) {
  ctx = { ready: true, ...next };
  if (next.admin) queue.length = 0;
  else if (queue.length) { clearTimeout(timer); timer = setTimeout(flush, 300); }
}

/** Remember that someone started signing in, so the page they come back to can count it as done. */
export function markSigningIn(where: 'sheet' | 'page' | 'email') {
  store.set(SIGNIN, String(Date.now()));
  track('signin_start', { detail: where });
}
export function takeSignedIn(): boolean {
  const at = Number(store.get(SIGNIN));
  if (!at) return false;
  store.del(SIGNIN);
  return Date.now() - at < SIGNIN_WINDOW;
}

/** One page view per route change, plus the first-view facts (where from, first view of the visit). */
export function usePageViews() {
  const { pathname } = useLocation();
  useEffect(() => {
    const route = routeName(pathname);
    if (!route) return;
    let first = false;
    try { first = sessionStorage.getItem(VISIT) === null; sessionStorage.setItem(VISIT, '1'); } catch { /* ignore */ }
    track('view', {
      route,
      slug: slugFromPath(pathname) ?? undefined,
      x: first ? 1 : 0,
      ref: first ? referrerHost(document.referrer, location.hostname) : undefined,
    });
  }, [pathname]);
}
