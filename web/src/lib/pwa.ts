import { useSyncExternalStore } from 'react';

// Chrome and Edge fire this once, early. It is kept here so the menu can use it whenever it opens.
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iPadOS reports itself as a Mac, with a touch screen.
const onIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as InstallEvent; emit(); });
window.addEventListener('appinstalled', () => { deferred = null; emit(); });

/** Only in the production build: in dev a cached shell would hide every change. */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

export type InstallState = 'none' | 'prompt' | 'ios';

function state(): InstallState {
  if (standalone()) return 'none';
  if (deferred) return 'prompt';
  return onIos() ? 'ios' : 'none';
}

/** What the menu can offer: a one-tap install (Chrome, Edge, Android), steps for iPhone and iPad, or nothing. */
export function useInstall() {
  const s = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, state, () => 'none' as InstallState);
  const install = async () => {
    if (!deferred) return;
    const ev = deferred;
    deferred = null; // a prompt can be used once
    emit();
    await ev.prompt();
  };
  return { state: s, install };
}
