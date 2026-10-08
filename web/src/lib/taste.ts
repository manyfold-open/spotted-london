import { useEffect, useSyncExternalStore } from 'react';
import { emptyTaste, parseTaste, type Taste } from '../../../src/shared/taste';
import { decideSync, freshMeta, parseMeta, type SyncMeta } from '../../../src/shared/taste-sync';
import { api, ApiError } from './api';
import { useMe } from './hooks';

// What you like. It lives on this device (localStorage `spotted.taste`) and is used from there, so "For you" works
// without a sign-in and without a network. Signed-in people also get a copy on their account (GET and PUT
// /me/taste) so a new device gets it back. Signed-out people never send it anywhere. The public list is the same
// for everyone and is re-ordered here. Without storage (private window) it lasts until the tab closes.
//
// Which copy wins is decided by decideSync in src/shared/taste-sync.ts (documented there). This file only does the
// storing, the timing and the requests. A failed request never loses anything: the local copy stays, marked as
// unsent, and the next try (the next change, or coming back to the tab) sends it.

const KEY = 'spotted.taste';
const META_KEY = 'spotted.taste.sync';
const PUSH_DELAY = 1500;
const PULL_EVERY = 60_000;
const subs = new Set<() => void>();

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window: keep it in memory */ }
};
const hasStore = typeof localStorage !== 'undefined';
let current: Taste = hasStore ? parseTaste(read(KEY)) : emptyTaste();
let meta: SyncMeta = hasStore ? parseMeta(read(META_KEY)) : freshMeta();
const notify = () => subs.forEach(f => f());
const setMeta = (m: SyncMeta) => { meta = m; write(META_KEY, JSON.stringify(m)); };

/** A change made on this device. */
function set(next: Taste) {
  if (next === current) return; // nothing changed: not a change to send
  current = next;
  write(KEY, JSON.stringify(next));
  setMeta({ ...meta, dirty: true, at: Date.now() });
  notify();
  schedulePush();
}

// Another tab changed it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key === KEY) { current = parseTaste(e.newValue); notify(); }
    else if (e.key === META_KEY) meta = parseMeta(e.newValue);
  });
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Your taste. The object only changes when the taste does. */
export const useTaste = () => useSyncExternalStore(subscribe, () => current, () => EMPTY);
const EMPTY = emptyTaste();

/** Changes the taste from its current value. */
export const updateTaste = (fn: (t: Taste) => Taste) => set(fn(current));

/** Starts again: forgets every answer, keeps nothing. */
export const resetTaste = () => set({ ...emptyTaste(), seen: true });

/** The taste right now, for code that is not a component. */
export const getTaste = () => current;

/* ---------- the account copy ---------- */

interface Remote { taste: Taste; updated_at: number }
let account: string | null = null; // who is signed in, null when nobody is
let ready = false; // this tab has compared with the account since sign-in
let timer: ReturnType<typeof setTimeout> | undefined;
let lastPull = 0;
let running: Promise<void> | null = null;

function adopt(uid: string, remote: Remote) {
  current = remote.taste;
  write(KEY, JSON.stringify(remote.taste));
  setMeta({ uid, base: remote.updated_at, dirty: false, at: meta.at });
  notify();
}

/** Sends the local taste. `base` is the account version this overwrites (0 when the account has none). */
async function push(uid: string, base: number, depth = 0): Promise<void> {
  const sent = current;
  setMeta({ ...meta, uid, dirty: true });
  try {
    const r = await api<Remote>('/me/taste', { method: 'PUT', json: { taste: sent, base } });
    // Changed again while the request was out: it is still unsent, and the next push follows.
    setMeta({ ...meta, uid, base: r.updated_at, dirty: current !== sent });
    if (current !== sent) schedulePush();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && depth < 2) {
      // Another device saved first: apply the merge rules to what is there now.
      const cur = (e.data as { current?: Remote | null } | undefined)?.current ?? null;
      return step(uid, cur, depth + 1);
    }
    // Not signed in any more, migration not applied yet, offline: keep it unsent and try again later.
  }
}

async function step(uid: string, server: Remote | null, depth = 0): Promise<void> {
  let action = decideSync({ uid, local: current, meta, server });
  if (action.do === 'drop_then_adopt') {
    // The taste on this device belongs to someone who signed out or lost their session: it is not this account's.
    current = emptyTaste();
    write(KEY, JSON.stringify(current));
    setMeta({ ...freshMeta(), uid });
    notify();
    action = decideSync({ uid, local: current, meta, server });
  }
  if (action.do === 'upload') return push(uid, server?.updated_at ?? 0, depth);
  if (action.do === 'adopt' && server) return adopt(uid, server);
  if (meta.uid !== uid) setMeta({ ...meta, uid });
}

/** Compares this device with the account and brings them together. Safe to call often. */
function reconcile(): Promise<void> {
  const uid = account;
  if (!uid) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    try {
      const r = await api<{ taste: Taste | null; updated_at: number | null }>('/me/taste');
      if (account !== uid) return; // signed out or switched while waiting
      lastPull = Date.now();
      await step(uid, r.taste ? { taste: r.taste, updated_at: r.updated_at ?? 0 } : null);
      ready = true;
    } catch { /* offline or not ready on the server: the device copy keeps working */ }
  })().finally(() => { running = null; });
  return running;
}

function schedulePush() {
  if (!account || !ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => { if (account && meta.dirty) void push(account, meta.base); }, PUSH_DELAY);
}

/** Who is signed in changed (or loaded). Signed-out people stay device only. */
function setAccount(uid: string | null) {
  if (uid === account) return;
  account = uid;
  ready = false;
  clearTimeout(timer);
  if (uid) void reconcile();
}

/** Sends anything still waiting. Call before signing out, while the session still works. */
export async function flushTaste(): Promise<void> {
  clearTimeout(timer);
  if (account && ready && meta.dirty) await push(account, meta.base);
}

/** Signing out: the taste goes with the session. The account keeps it; signing in again brings it back. */
export function forgetTaste() {
  clearTimeout(timer);
  account = null;
  ready = false;
  current = emptyTaste();
  write(KEY, null);
  write(META_KEY, null);
  meta = freshMeta();
  notify();
}

/** Mount once. Keeps this device and the account of the signed-in person in step. */
export function useTasteSync() {
  const { data: me } = useMe();
  const uid = me?.id ?? null;
  useEffect(() => { if (me !== undefined) setAccount(uid); }, [me, uid]);
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible' && account && Date.now() - lastPull > PULL_EVERY) void reconcile(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
}

/** The privacy line next to "For you": where your picks are kept. True for signed-in and signed-out people. */
export function useKeptNote(): string {
  const { data: me } = useMe();
  return me
    ? 'Your picks are saved to your account, so they follow you to other devices. Deleting your account deletes them.'
    : 'Your picks stay on this device. Sign in to keep them on your account.';
}
