import { useSyncExternalStore } from 'react';
import { emptyTaste, parseTaste, type Taste } from '../../../src/shared/taste';

// What you like, kept on this device only (localStorage `spotted.taste`). It never goes to the server: the
// public list is the same for everyone and is re-ordered here. Without storage (private window) it lasts
// until the tab closes.

const KEY = 'spotted.taste';
const subs = new Set<() => void>();

const read = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
let current: Taste = typeof localStorage === 'undefined' ? emptyTaste() : parseTaste(read());

function set(next: Taste) {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window: keep it in memory */ }
  subs.forEach(f => f());
}

// Another tab changed it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== KEY) return;
    current = parseTaste(e.newValue);
    subs.forEach(f => f());
  });
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Your taste. The object only changes when the taste does. */
export const useTaste = () => useSyncExternalStore(subscribe, () => current, () => EMPTY);
const EMPTY = emptyTaste();

/** Changes the taste from its current value. Returning the same object changes nothing (no write, no re-render). */
export const updateTaste = (fn: (t: Taste) => Taste) => { const next = fn(current); if (next !== current) set(next); };

/** Starts again: forgets every answer, keeps nothing. */
export const resetTaste = () => set({ ...emptyTaste(), seen: true });

/** The taste right now, for code that is not a component. */
export const getTaste = () => current;
