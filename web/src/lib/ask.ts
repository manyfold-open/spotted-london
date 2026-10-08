import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, type AskPick, type AskStatus, type AskView } from './api';
import type { TasteSummary } from '../../../src/shared/taste';

// Ask for recommendations, on this device. The question and the answer live in memory only (not in localStorage)
// and the polling runs here, not in the panel, so closing the panel while the agent thinks loses nothing.
// What goes to the server: the question, a taste summary (categories) and whether the browser can order by
// distance. Your position is never sent; `near` only tells the browser to do that ordering itself.

export type AskPhase = 'idle' | 'sending' | 'pending' | 'done' | 'failed';

export interface AskState {
  phase: AskPhase;
  /** The question being answered or last answered. */
  question: string;
  startedAt: number;
  picks: AskPick[];
  note: string;
  /** The agent says the request was about where you are, and the browser may order by distance. */
  near: boolean;
  /** Why there is no answer (a limit, a failure). Shown as is. */
  message: string | null;
  /** The visitor cannot ask again today (limit reached, or Ask is resting). */
  blocked: boolean;
  /** Something to fix before asking again, like an empty question. */
  error: string | null;
  /** An answer arrived that the visitor has not looked at yet. */
  unseen: boolean;
}

const IDLE: AskState = { phase: 'idle', question: '', startedAt: 0, picks: [], note: '', near: false, message: null, blocked: false, error: null, unseen: false };
let state: AskState = IDLE;
let run = 0; // a newer question ends the polling of an older one
const subs = new Set<() => void>();
const set = (patch: Partial<AskState>) => { state = { ...state, ...patch }; subs.forEach(f => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const useAsk = () => useSyncExternalStore(subscribe, () => state, () => IDLE);
export const markAskSeen = () => { if (state.unseen) set({ unseen: false }); };

/** Whether to show Ask at all, and what is left today. Any failure just means "not available". */
export function useAskStatus() {
  return useQuery({
    queryKey: ['ask', 'status'],
    queryFn: () => api<AskStatus>('/ask/status'),
    staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false,
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const GIVE_UP = 4; // polls in a row that could not reach Spotted

function apply(v: AskView, qc: QueryClient) {
  if (v.left !== undefined) {
    qc.setQueryData<AskStatus>(['ask', 'status'], s => s && { ...s, left: v.left!, needs_bot_check: false });
  }
  if (v.status === 'done') set({ phase: 'done', picks: v.picks, note: v.note, near: v.near, message: null, unseen: true });
  else if (v.status === 'failed') set({ phase: 'failed', message: v.message, unseen: true });
}

/** Sends a question and follows it until it is answered, fails or a newer question replaces it. */
export async function ask(qc: QueryClient, o: { text: string; taste: TasteSummary | null; nearMe: boolean; token: string | null }) {
  const me = ++run;
  set({ ...IDLE, phase: 'sending', question: o.text.trim(), startedAt: Date.now() });
  let v: AskView;
  try {
    v = await api<AskView>('/ask', { method: 'POST', json: { text: o.text, ...(o.taste ? { taste: o.taste } : {}), near_me: o.nearMe, ...(o.token ? { turnstile_token: o.token } : {}) } });
  } catch (e) {
    if (me !== run) return;
    const err = e instanceof ApiError ? e : null;
    if (err && (err.code === 'ask_limit' || err.code === 'ask_resting')) {
      qc.setQueryData<AskStatus>(['ask', 'status'], s => s && { ...s, left: 0, resting: err.code === 'ask_resting' || s.resting });
      return set({ phase: 'failed', message: err.message, blocked: true, unseen: false });
    }
    // a mistake the visitor can fix (empty question, bot check): back to the form with the message
    return set({ phase: 'idle', error: e instanceof Error ? e.message : 'Something went wrong. Try again.' });
  }
  if (me !== run) return;
  apply(v, qc);
  let misses = 0;
  while (me === run && v.status === 'pending') {
    await sleep(v.poll_ms);
    if (me !== run) return;
    try {
      v = await api<AskView>(`/ask/${v.id}`);
      misses = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return set({ phase: 'failed', message: e.message, unseen: false });
      if (++misses >= GIVE_UP) return set({ phase: 'failed', message: 'Could not reach Spotted. Check your connection and ask again. The filters and For you still work.', unseen: false });
      continue;
    }
    if (me !== run) return;
    if (v.status === 'pending') continue;
    apply(v, qc);
  }
}

/** Back to a blank form (keeps nothing of the last answer). */
export const clearAsk = () => { run++; set({ ...IDLE }); };
export const useAskActions = () => ({ clear: useCallback(clearAsk, []) });
