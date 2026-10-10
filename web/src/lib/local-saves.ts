import { useSyncExternalStore } from 'react';
import { parseSaves, withSave, type LocalSave } from '../../../src/shared/local-saves';

// Pop-ups saved while signed out. They live on this device (localStorage `spotted.saved`) and move to the account
// the moment you sign in (`useMoveLocalSaves` in Shell). Nothing is sent anywhere while signed out.

const KEY = 'spotted.saved';
let memory: LocalSave[] | null = null; // what we hold; also the whole store when the browser blocks localStorage
const subs = new Set<() => void>();

function read(): LocalSave[] {
  if (memory) return memory;
  try { memory = parseSaves(localStorage.getItem(KEY)); } catch { memory = []; }
  return memory;
}
function write(next: LocalSave[]) {
  memory = next;
  try { localStorage.setItem(KEY, JSON.stringify({ v: 1, saves: next })); } catch { /* blocked or full: kept in memory for this visit */ }
  subs.forEach(f => f());
}

// Another tab changed it
window.addEventListener('storage', e => { if (e.key === KEY) { memory = null; subs.forEach(f => f()); } });

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const EMPTY: LocalSave[] = [];

/** The pop-ups saved on this device, oldest first. */
export const useLocalSaves = () => useSyncExternalStore(subscribe, read, () => EMPTY);

export const hasLocalSave = (id: string) => read().some(s => s.id === id);
export const setLocalSave = (id: string, on: boolean) => write(withSave(read(), id, on, Date.now()));
export const localSaveIds = () => read().map(s => s.id);
/** Forgets these ones (after they reached the account). */
export const dropLocalSaves = (ids: readonly string[]) => { const gone = new Set(ids); write(read().filter(s => !gone.has(s.id))); };
