// AES-GCM sealing for credentials Spotted must be able to read back (the Manyfold caller token).
// The key comes from the AGENTS_KEY secret, never from the database.

import { b64url } from './auth';
import { ApiError } from './util';

async function keyFrom(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new ApiError(501, 'agents_key_missing', 'The AGENTS_KEY secret is not set (32 characters or more). Add it with `npx wrangler secret put AGENTS_KEY`.');
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

/** Returns "iv.ciphertext", both base64url. */
export async function seal(secret: string | undefined, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(secret), new TextEncoder().encode(plain));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function unseal(secret: string | undefined, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split('.');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await keyFrom(secret), fromB64url(ct));
    return new TextDecoder().decode(plain);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(409, 'token_unreadable', 'The saved agent token cannot be read, probably because AGENTS_KEY changed. Paste the token again.');
  }
}
