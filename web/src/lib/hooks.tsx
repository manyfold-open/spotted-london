import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Category, type Me, type MyStateMap, type When } from './api';
import { seedPopup } from './cache';
import { useLocalSaves } from './local-saves';
import type { GateAsk, GateIntent } from '../../../src/shared/gate';
import { reducedMotion } from './motion';
import { Icon, type IconName } from '../components/Icon';
import { noteOpenVia, track } from './track';
import { filterEvent, type OpenVia } from '../../../src/shared/tracking';

/* ---------- current user ---------- */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try { return await api<Me>('/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
    },
    staleTime: 60_000,
  });
}

/**
 * Your saves and votes on current pop-ups, or undefined while loading (and when signed out with nothing saved).
 * Signed out, it is only what you saved on this device (no votes): enough to show the bookmarks. The public list has none.
 */
export function useMyState() {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['me', 'state'], queryFn: () => api<MyStateMap>('/me/state'), enabled: !!me, staleTime: 60_000 });
  const local = useLocalSaves();
  const mine = useMemo(() => (local.length ? { saved: local.map(s => s.id), votes: {} } : undefined), [local]);
  if (me) return q.data;
  return me === null ? mine : undefined;
}

/* ---------- sign in on the spot ---------- */
export const GateCtx = createContext<(ask: GateAsk) => void>(() => {});
export const useGate = () => useContext(GateCtx);

/**
 * Wraps an action so signed-out people get the sign-in sheet instead of an error, right where they are. After
 * Google sends them back, Shell finishes the action (`intent`) or says they can go ahead (`then`).
 */
export function useRequireAuth() {
  const { data: me } = useMe();
  const ask = useGate();
  return useCallback(<A extends unknown[]>(fn: (...a: A) => unknown, why = 'Sign in to do that', opts: { then?: string; intent?: (...a: A) => GateIntent } = {}) => (...a: A) => {
    if (!me) {
      ask({ why, then: opts.then, intent: opts.intent?.(...a) });
      return;
    }
    return fn(...a);
  }, [me, ask]);
}

/* ---------- toasts ---------- */
type Toast = { id: number; msg: string; icon: IconName; err?: boolean; out?: boolean };
const ToastCtx = createContext<(msg: string, icon?: IconName, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const n = useRef(0);
  const push = useCallback((msg: string, icon: IconName = 'i-check', err = false) => {
    const id = ++n.current;
    setItems(t => [...t.slice(-2), { id, msg, icon, err }]);
    setTimeout(() => setItems(t => t.map(x => (x.id === id ? { ...x, out: true } : x))), 3400);
    setTimeout(() => setItems(t => t.filter(x => x.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast ${t.err ? 'err' : ''} ${t.out ? 'out' : ''}`}><Icon name={t.icon} /><span>{t.msg}</span></div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Shows an API error as a toast. */
export function useErrorToast() {
  const toast = useToast();
  return useCallback((e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong.', 'i-info', true), [toast]);
}

/* ---------- filters live in the URL so they survive reloads and can be shared ---------- */
export function useFilters() {
  const [sp, setSp] = useSearchParams();
  const when = (['today', 'weekend', 'week', 'all'].includes(sp.get('when') ?? '') ? sp.get('when') : 'week') as When;
  const category = (sp.get('cat') ?? '') as Category | '';
  const verified = sp.get('verified') === '1';
  const saved = sp.get('saved') === '1'; // only what you saved; per person, so it is applied in the browser after filterPopups
  const q = sp.get('q') ?? '';
  const query = useRef(q);
  query.current = q;
  const set = useCallback((patch: Record<string, string | null>) => {
    const seen = filterEvent(patch, query.current);
    if (seen) track(seen.name, { detail: seen.detail || undefined });
    setSp(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
      return next;
    }, { replace: true });
  }, [setSp]);
  return useMemo(() => ({ when, category, verified, saved, q, set }), [when, category, verified, saved, q, set]);
}

/* ---------- the pop-up sheet is ?p=<slug> on any list page ---------- */
export function useSheet() {
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  /**
   * Opens a pop-up. Pass the cover it was opened from and, where the browser supports view
   * transitions, that cover grows into the sheet's header. `via` says where the tap was (map, ask, saved, own) for the stats.
   */
  const open = useCallback((slug: string, from?: Element | null, via?: OpenVia) => {
    seedPopup(qc, slug);
    const sp = new URLSearchParams(loc.search);
    // How it was reached: a list tap while a search is typed counts as search; a bare open from a list is `list`
    noteOpenVia(via ?? (sp.get('q')?.trim() ? 'search' : 'list'));
    sp.set('p', slug);
    const to = { pathname: loc.pathname.startsWith('/p/') ? '/' : loc.pathname, search: sp.toString() };
    const cover = from instanceof HTMLElement ? from : null;
    if (!cover || !document.startViewTransition || reducedMotion() || !qc.getQueryData(['popup', slug])) {
      void nav(to, { state: { sheet: true } });
      return;
    }
    cover.style.viewTransitionName = 'cover';
    cover.classList.add('vt-src'); // leave the card's tags and buttons out of the picture that flies
    const t = document.startViewTransition(async () => {
      cover.style.viewTransitionName = '';
      cover.classList.remove('vt-src');
      await nav(to, { state: { sheet: true, vt: true }, flushSync: true });
    });
    t.finished.finally(() => { cover.style.viewTransitionName = ''; cover.classList.remove('vt-src'); });
  }, [nav, loc, qc]);
  const close = useCallback(() => {
    if ((loc.state as { sheet?: boolean } | null)?.sheet) return nav(-1);
    const sp = new URLSearchParams(loc.search);
    sp.delete('p');
    nav({ pathname: loc.pathname.startsWith('/p/') ? '/' : loc.pathname, search: sp.toString() }, { replace: true });
    qc.invalidateQueries({ queryKey: ['popups'] });
  }, [nav, loc, qc]);
  return { open, close };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** One-shot browser location, as a promise with readable errors. */
export function currentPosition(): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share your location.'));
    navigator.geolocation.getCurrentPosition(
      p => resolve([p.coords.latitude, p.coords.longitude]),
      e => reject(new Error(e.code === 1 ? 'Location is blocked. Allow it in your browser settings for this site.' : 'We could not find your location. Try again outside.')),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  });
}
