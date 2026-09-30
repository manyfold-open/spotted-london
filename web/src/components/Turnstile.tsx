// Cloudflare Turnstile bot check. Renders nothing when the server has no site key
// (local development), in which case the server skips the check too.
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Providers { email: boolean; google: boolean; photos: boolean; turnstile_site_key: string | null }

export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: () => api<Providers>('/auth/providers'), staleTime: Infinity });
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id: string) => void;
      remove: (id: string) => void;
    };
  }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error('The bot check did not load. Check your connection.')); };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Calls onToken with a fresh token, or null when it expires. `resetKey` changes force a new
 * challenge, since each token can be used once.
 */
export function Turnstile({ onToken, resetKey = 0 }: { onToken: (t: string | null) => void; resetKey?: number }) {
  const { data } = useProviders();
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const siteKey = data?.turnstile_site_key;

  useEffect(() => {
    if (!siteKey || !el.current) return;
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !el.current || !window.turnstile) return;
      id.current = window.turnstile.render(el.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      });
    }).catch(() => cb.current(null));
    return () => { cancelled = true; if (id.current && window.turnstile) window.turnstile.remove(id.current); id.current = null; };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey && id.current && window.turnstile) { window.turnstile.reset(id.current); cb.current(null); }
  }, [resetKey]);

  if (!siteKey) return null;
  return <div ref={el} className="turnstile" />;
}

/** True when a token is needed before submitting. */
export function useNeedsTurnstile() {
  return !!useProviders().data?.turnstile_site_key;
}
