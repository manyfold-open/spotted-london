import { useCallback, useEffect, useRef, useState } from 'react';
import { currentPosition, useErrorToast } from './hooks';
import { nearMeStart, type GeoPermission } from './map-home';

export type NearState = 'idle' | 'asking' | 'on' | 'denied' | 'unsupported';

const KEY = 'spotted.near';
const read = (): '1' | '0' | null => { try { const v = localStorage.getItem(KEY); return v === '1' || v === '0' ? v : null; } catch { return null; } };
const write = (v: '1' | '0') => { try { localStorage.setItem(KEY, v); } catch { /* private window */ } };
/** True once this device has answered the location card (agreed or not now). */
export const nearChoiceMade = (): boolean => read() !== null;

/**
 * Where you are, for the map home. The position lives in memory only and never goes to the server:
 * the nearby filter and the distances are worked out in the browser.
 */
export function useNearMe() {
  const onError = useErrorToast();
  const [state, setState] = useState<NearState>(() => (typeof navigator !== 'undefined' && navigator.geolocation ? 'idle' : 'unsupported'));
  const [pos, setPos] = useState<[number, number] | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [filter, setFilter] = useState(false);
  const busy = useRef(false);

  const request = useCallback(async () => {
    if (!navigator.geolocation) { setState('unsupported'); return null; }
    if (busy.current) return null;
    busy.current = true;
    setState('asking');
    try {
      const p = await currentPosition();
      setPos(p); setState('on'); setFilter(true); setPrompt(false); write('1');
      return p;
    } catch (e) {
      const blocked = e instanceof Error && e.message.startsWith('Allow location');
      setState(blocked ? 'denied' : 'idle');
      setPrompt(false);
      onError(e);
      return null;
    } finally { busy.current = false; }
  }, [onError]);

  // On first open: locate silently if allowed and used before, otherwise show the prompt card.
  useEffect(() => {
    if (state === 'unsupported') return;
    let live = true;
    const start = (perm: GeoPermission) => {
      if (!live) return;
      if (perm === 'denied') setState('denied');
      const what = nearMeStart(perm, read());
      if (what === 'auto') void request();
      else if (what === 'prompt') setPrompt(true);
    };
    const q = navigator.permissions?.query({ name: 'geolocation' });
    if (q) q.then(r => start(r.state), () => start('unknown')); else start('unknown');
    return () => { live = false; };
    // runs once; request is stable enough for a first-open decision
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissPrompt = useCallback(() => { setPrompt(false); write('0'); }, []);
  return { state, pos, prompt, filter, setFilter, request, dismissPrompt };
}
