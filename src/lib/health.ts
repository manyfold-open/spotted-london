// Pure rules for the health checks of Ask and autofill (docs/superpowers/specs/2026-10-15-health-checks-design.md).

import { ApiError } from './util';

export type Outcome = 'ok' | 'failed' | 'other';

/** Under this share of working calls today, with at least FLAG_MIN_CALLS calls, the panel marks the feature. */
export const FLAG_BELOW = 0.8;
export const FLAG_MIN_CALLS = 5;

/** ok / (ok + failed). `other` is not the feature's fault, so it does not count. Null when nothing ran. */
export function successRate(d: { ok: number; failed: number }): number | null {
  const calls = d.ok + d.failed;
  return calls > 0 ? d.ok / calls : null;
}

export function isFlagged(d: { ok: number; failed: number }): boolean {
  const rate = successRate(d);
  return d.ok + d.failed >= FLAG_MIN_CALLS && rate !== null && rate < FLAG_BELOW;
}

/** Errors that mean the site or the text gave us nothing to read: not the AI's fault. */
const OTHER_CODES = new Set(['fetch_failed', 'unreadable_link', 'unreadable_text', 'unreadable_image']);
/** Errors that mean the model did not do its job. */
const FAILED_CODES = new Set(['ai_failed', 'ai_quota']);

/**
 * How an autofill request that threw counts. Null: refused before any work (no input, daily limit, wrong file type,
 * AI not switched on), so it says nothing about whether autofill works. Anything that is not an ApiError is our bug.
 */
export function classifyAutofillError(e: unknown): Outcome | null {
  if (!(e instanceof ApiError)) return 'failed';
  if (FAILED_CODES.has(e.code)) return 'failed';
  if (OTHER_CODES.has(e.code)) return 'other';
  return null;
}

/** A made-up announcement for the autofill test: it has a name, a place and dates, so a working model finds them. */
export const AUTOFILL_SAMPLE =
  'The Marmalade Market is coming to Hackney! A free pop-up of local makers, jams and ceramics. ' +
  'Saturday 7 and Sunday 8 November 2026, 11am to 5pm, at 14 Mare Street, London E8 3QE. Free entry. Hosted by Marmalade Co.';

/** The question the Ask test sends. Broad on purpose, so any live list has something to pick. */
export const ASK_TEST_QUESTION = 'Something free to do this weekend';

export const TEST_GAP_MS = 60_000;
