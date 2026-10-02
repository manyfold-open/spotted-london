// Small motion helpers. CSS does most of the work; these cover what CSS cannot.
import { useEffect, useState, useSyncExternalStore } from 'react';

const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reducedMotion = () => !!reducedQuery?.matches;
export const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches;

/** A short buzz on phones that support it (Android). iOS ignores it. */
export function haptic(pattern: number | number[] = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* not allowed here */ }
}

/** A quick springy pop, for a button that just changed state. */
export function bump(el: Element | null | undefined) {
  if (!el || reducedMotion() || !('animate' in el)) return;
  el.animate([{ scale: 1 }, { scale: 1.22 }, { scale: 1 }], { duration: 320, easing: 'cubic-bezier(.3, 1.5, .5, 1)' });
}

/**
 * Keeps the last value around for `ms` after it goes to null, so the thing can play its exit
 * animation before it unmounts. Returns [value to render, leaving].
 */
export function useExit<T>(value: T | null, ms: number): [T | null, boolean] {
  const [kept, setKept] = useState(value);
  if (value !== null && value !== kept) setKept(value);
  useEffect(() => {
    if (value !== null || kept === null) return;
    const t = setTimeout(() => setKept(null), ms);
    return () => clearTimeout(t);
  }, [value, kept, ms]);
  return [value ?? kept, value === null && kept !== null];
}

export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? 'auto' : 'smooth');

/** True under 900 px, and follows the window when it is resized or rotated. */
export function usePhone() {
  return useSyncExternalStore(
    cb => { const q = matchMedia('(max-width: 899px)'); q.addEventListener('change', cb); return () => q.removeEventListener('change', cb); },
    isPhone,
    () => false,
  );
}
