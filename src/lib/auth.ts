// Tokens, cookies and PKCE helpers for sign in.

import { DAY } from './scoring';

export const SESSION_COOKIE = 'sid';
export const OAUTH_COOKIE = 'oauth_state';
export const SESSION_TTL = 30 * DAY;
export const MAGIC_TTL = 15 * 60_000;
export const OAUTH_TTL = 10 * 60_000;

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

/** 256 bits of randomness, URL safe. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

/** Only same-site relative paths are allowed as a post-login destination. */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 200);
}

export function normaliseEmail(v: string): string | null {
  const e = v.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254 ? e : null;
}

/** Payload of a JWT. Only used on id_tokens received straight from Google over TLS (OIDC Core 3.1.3.7). */
export function jwtPayload<T>(jwt: string): T | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try { return JSON.parse(b64urlDecode(part)) as T; } catch { return null; }
}
