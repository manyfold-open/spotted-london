import { useSyncExternalStore } from 'react';
import { routeName } from '../../../src/shared/tracking';
import { appUrl, BASE } from './base';
import { trackingOptedOut } from './track';

// Google Analytics 4. The Worker names the property in a <meta name="spotted-analytics"> on production pages of the
// public site only (src/analytics.ts); without it (local dev, previews, workers.dev) nothing here does anything.
// What is sent and why is on the privacy page (src/privacy.ts); keep both in step.
//  - Google's tag is loaded only once it may: after "Allow" where the visitor is asked (the UK, the EEA, Switzerland,
//    unknown country), at once elsewhere, and never while the visitor says no (the switch in the menu changes it).
//  - Off for admins, and when the browser says Do Not Track or Global Privacy Control, or the Me page stats switch is
//    off (the same rules as the anonymous stats in track.ts).
//  - No ads: ad storage is denied and Google signals are off. Its cookies are spotted_ga and spotted_ga_<id>, kept on
//    this host and under the site's path, for 13 months.
//  - Page views are sent from here, not by the tag, with a clean address: the page's path, never its query string
//    (which can hold what someone typed in search), plus any utm_ campaign tags. A pop-up opened as a sheet over a
//    list counts as a view of its own page, /p/<slug>.

export type Consent = 'granted' | 'denied';

declare global {
  interface Window { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void }
}

const KEY = 'spotted.ga';
const COOKIE_PREFIX = 'spotted';
const meta = document.querySelector<HTMLMetaElement>('meta[name="spotted-analytics"]');
// `wrangler dev` hands the Worker the production host, so a local run without .dev.vars would name the property too.
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const ID = meta && !local && /^G-[A-Z0-9]{4,24}$/.test(meta.content) ? meta.content : null;
/** Whether this visitor is asked before anything is measured. */
const ASK = meta?.dataset.ask !== '0';

const TITLES: Record<string, string> = {
  home: 'Spotted London', add: 'Add a pop-up', saved: 'Saved', connect: 'Use with your AI', me: 'Me', signin: 'Sign in', other: 'Page not found',
};

const read = (): Consent | null => {
  try { const v = localStorage.getItem(KEY); return v === 'granted' || v === 'denied' ? v : null; } catch { return null; }
};

let answer = read();
let viewer: { ready: boolean; admin: boolean } = { ready: false, admin: false };
let loaded = false;
let shown: { location: string; title: string } | null = null;
let counted: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Whether the visitor allows it: they said yes, or were not asked and did not say no. */
const allowed = () => (answer ?? (ASK ? 'denied' : 'granted')) === 'granted';
/** Whether Google's tag may run on this page now. */
const measuring = () => ID !== null && viewer.ready && !viewer.admin && !trackingOptedOut() && allowed();
/** Whether the visitor is owed the question: measured, asked here, not opted out, and not answered. */
const owed = () => ID !== null && ASK && answer === null && !trackingOptedOut();

function gtag(...args: unknown[]) { window.gtag?.(...args); }

function send() {
  if (!shown || shown.location === counted) return;
  counted = shown.location;
  // Later events (engagement time, outbound clicks) carry this address too, not the real one with its query string.
  gtag('set', { page_location: shown.location, page_title: shown.title });
  gtag('event', 'page_view', { page_location: shown.location, page_title: shown.title });
}

function start() {
  if (!ID) return;
  (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`] = false;
  if (!loaded) {
    loaded = true;
    window.dataLayer = window.dataLayer ?? [];
    // The tag reads its commands as `arguments` objects, not arrays.
    window.gtag = function () { window.dataLayer!.push(arguments); }; // eslint-disable-line prefer-rest-params
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', ID, {
      send_page_view: false,
      cookie_prefix: COOKIE_PREFIX,
      cookie_domain: location.hostname,
      cookie_path: BASE || '/',
      cookie_expires: 395 * 24 * 60 * 60,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${ID}`;
    document.head.append(script);
  } else gtag('consent', 'update', { analytics_storage: 'granted' });
  counted = null;
  send();
}

/** Stops measuring on this page at once, and forgets the cookies the tag set. */
function stop() {
  if (!ID || !loaded) return;
  gtag('consent', 'update', { analytics_storage: 'denied' });
  (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`] = true;
  for (const name of document.cookie.split(';').map(pair => pair.split('=')[0]!.trim())) {
    if (name.startsWith(`${COOKIE_PREFIX}_ga`)) document.cookie = `${name}=; max-age=0; path=${BASE || '/'}; domain=${location.hostname}`;
  }
}

/** Starts or stops the tag to match the answer, the viewer and the opt-outs. Call it after changing any of them. */
export function syncAnalytics() {
  if (measuring()) start(); else stop();
  version++;
  for (const l of listeners) l();
}

/** Keeps the visitor's answer on this device and acts on it. */
export function setConsent(choice: Consent) {
  answer = choice;
  try { localStorage.setItem(KEY, choice); } catch { /* private window: the answer holds until the page closes */ }
  syncAnalytics();
}

/** Shell says who is looking once the account has loaded. Nothing is sent before that, so admins are never counted. */
export function setAnalyticsViewer(admin: boolean) {
  if (viewer.ready && viewer.admin === admin) return;
  viewer = { ready: true, admin };
  syncAnalytics();
}

/** A page view for an in-app path ('/', '/saved', '/p/<slug>'). The same address twice in a row counts once. */
export function gaView(path: string, title?: string) {
  if (!ID) return;
  const route = routeName(path);
  if (!route) return; // admin pages
  const utm = new URLSearchParams([...new URLSearchParams(location.search)].filter(([k]) => k.startsWith('utm_'))).toString();
  shown = { location: `${location.origin}${appUrl(route === 'home' ? '/' : path)}${utm ? `?${utm}` : ''}`, title: title ? `${title} · Spotted London` : TITLES[route] ?? TITLES.home };
  if (measuring() && loaded) send();
}

/** For the consent card and the menu switch. */
export function useAnalytics() {
  useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => version, () => 0);
  return { shown: ID !== null && !trackingOptedOut(), owed: owed(), on: allowed() };
}
