// How a taste kept on a device and the taste kept on the account are brought together. Plain functions with no
// imports from the Worker, so the web app and the tests run the same code. This file never changes how a taste is
// scored (that is src/shared/taste.ts); it only decides which copy to keep.

import { parseTaste, type Taste } from './taste';

/**
 * The largest taste body the account accepts. What is stored is always the output of parseTaste, which bounds every
 * part of it (categories, 80 areas, and whatever else the taste holds), so this only stops absurd bodies early.
 * A taste today is a few KB at most; it is set high enough to leave room for a taste that also remembers saves and
 * votes (up to 1,000 pop-ups). If the taste ever holds more than that, raise it together with that change.
 */
export const TASTE_MAX_BYTES = 256_000;

/** Someone has answered at least one card, or the deck was dealt with. An untouched default taste is "empty". */
export const hasAnswers = (t: Taste) => t.swipes > 0;

/**
 * What the browser remembers about the link between its local copy and the account (localStorage
 * `spotted.taste.sync`). `uid` is who the local copy belongs to, `base` the account version (`updated_at`) it was
 * last in step with, `dirty` that it changed since, and `at` when it last changed on this device (0 if unknown,
 * for a taste made before sync existed).
 */
export interface SyncMeta { uid: string | null; base: number; dirty: boolean; at: number }

export const freshMeta = (): SyncMeta => ({ uid: null, base: 0, dirty: false, at: 0 });

/** Reads what was stored. Anything odd gives a fresh meta. */
export function parseMeta(raw: string | null | undefined): SyncMeta {
  try {
    const v = JSON.parse(raw ?? '') as Partial<SyncMeta> | null;
    if (!v || typeof v !== 'object') return freshMeta();
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
    return { uid: typeof v.uid === 'string' ? v.uid : null, base: n(v.base), dirty: v.dirty === true, at: n(v.at) };
  } catch { return freshMeta(); }
}

/** Validates a taste sent to the account. Returns the cleaned taste, or why it was refused. */
export function checkTasteBody(raw: unknown): { ok: true; taste: Taste; json: string } | { ok: false; code: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { v?: unknown }).v !== 1) {
    return { ok: false, code: 'taste_invalid', message: 'That is not a taste Spotted can read.' };
  }
  const sent = JSON.stringify(raw);
  if (sent.length > TASTE_MAX_BYTES) return { ok: false, code: 'taste_too_large', message: 'That taste is too large to save.' };
  const taste = parseTaste(sent);
  const json = JSON.stringify(taste);
  return { ok: true, taste, json };
}

export type SyncAction =
  | { do: 'none' }
  /** Send the local taste (with `base`) to the account. */
  | { do: 'upload' }
  /** Replace the local taste with the account's and note its version. */
  | { do: 'adopt' }
  /** The local copy belonged to someone else: drop it, then follow the other rules with an empty one. */
  | { do: 'drop_then_adopt' };

export interface SyncInput {
  uid: string;
  local: Taste;
  meta: SyncMeta;
  /** null when the account holds no taste yet. */
  server: { taste: Taste; updated_at: number } | null;
}

/**
 * Which copy wins when someone is signed in. The rules, in order:
 *  1. A local taste that belongs to a different account is dropped (a shared browser must not hand one person's
 *     picks to the next person who signs in).
 *  2. The account has nothing: send the local taste if it has answers, which is how a taste made before sign-in
 *     (or before sync existed) reaches the account. An empty local taste sends nothing.
 *  3. The account has one and this device was never linked to it (the first sign-in here): an empty local taste
 *     takes the account's. If both have answers, the more recent change wins as a whole: the local one only when
 *     its change time is known and is after the account's `updated_at`; a local taste of unknown age loses.
 *  4. This device is linked and the account has not moved since `base`: send local changes if there are any.
 *  5. The account moved since `base` (another device changed it): if this device has no unsent change, take the
 *     account's. If it has one too, the more recent change wins as a whole, by the same test as in rule 3.
 * Nothing is merged answer by answer: a taste is a handful of tallies, and "Retake" is one tap.
 */
export function decideSync({ uid, local, meta, server }: SyncInput): SyncAction {
  if (meta.uid && meta.uid !== uid) return { do: 'drop_then_adopt' };
  const localNewer = (s: { updated_at: number }) => meta.at > 0 && meta.at > s.updated_at;
  if (!server) return hasAnswers(local) || meta.dirty ? { do: 'upload' } : { do: 'none' };
  const linked = meta.uid === uid;
  if (!linked) {
    if (!hasAnswers(local)) return { do: 'adopt' };
    return localNewer(server) ? { do: 'upload' } : { do: 'adopt' };
  }
  if (server.updated_at <= meta.base) return meta.dirty ? { do: 'upload' } : { do: 'none' };
  if (!meta.dirty) return { do: 'adopt' };
  return localNewer(server) ? { do: 'upload' } : { do: 'adopt' };
}
