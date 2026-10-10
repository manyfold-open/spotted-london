import { useSyncExternalStore } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, type AskPick, type AskStatus, type AskView } from './api';
import type { TasteSummary } from '../../../src/shared/taste';

// Ask, as a chat on this device. The conversation and its open or minimised state live in memory only (never in
// localStorage), and the polling runs here, not in the window, so minimising or leaving the page while the agent
// thinks loses nothing. What goes to the server: the question, a taste summary (categories) and whether the browser
// can order by distance. Your position is never sent; `near` only tells the browser to do that ordering itself.

export type AskPhase = 'sending' | 'pending' | 'done' | 'failed';

/** One question and its answer. */
export interface Turn {
  id: number;
  /** What the visitor typed (what the thread shows). The text sent may carry the earlier question too. */
  question: string;
  phase: AskPhase;
  startedAt: number;
  picks: AskPick[];
  note: string;
  /** The agent says the request was about where you are, and the browser may order by distance. */
  near: boolean;
  /** Why there is no answer (a limit, a failure). Shown as is. */
  message: string | null;
}

export interface AskState {
  /** The chat window is open (otherwise it is the bubble). */
  open: boolean;
  turns: Turn[];
  /** The visitor cannot ask again today (limit reached, or Ask is resting). */
  blocked: boolean;
  /** Something to fix before asking again, like an empty question. */
  error: string | null;
  /** The text of a question that was not accepted, to put back in the box. */
  draft: string | null;
  /** An answer arrived while the window was minimised. */
  unseen: boolean;
}

const IDLE: AskState = { open: false, turns: [], blocked: false, error: null, draft: null, unseen: false };
/** Turns kept in the thread. Older ones scroll away for good. */
export const MAX_TURNS = 10;
let state: AskState = IDLE;
let run = 0; // a newer question ends the polling of an older one
let turnId = 0;
const subs = new Set<() => void>();
const set = (patch: Partial<AskState>) => { state = { ...state, ...patch }; subs.forEach(f => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const patchTurn = (id: number, patch: Partial<Turn>, rest: Partial<AskState> = {}) => set({ turns: state.turns.map(t => (t.id === id ? { ...t, ...patch } : t)), ...rest });

export const useAsk = () => useSyncExternalStore(subscribe, () => state, () => IDLE);
export const openAsk = () => set({ open: true, unseen: false });
export const closeAsk = () => set({ open: false });
export const markAskSeen = () => { if (state.unseen) set({ unseen: false }); };
/** The last question is being answered. */
export const isAsking = (s: AskState) => { const t = s.turns.at(-1); return !!t && (t.phase === 'sending' || t.phase === 'pending'); };

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

function apply(id: number, v: AskView, qc: QueryClient) {
  if (v.left !== undefined) {
    qc.setQueryData<AskStatus>(['ask', 'status'], s => s && { ...s, left: v.left!, needs_bot_check: false });
  }
  const unseen = !state.open;
  if (v.status === 'done') patchTurn(id, { phase: 'done', picks: v.picks, note: v.note, near: v.near, message: null }, { unseen });
  else if (v.status === 'failed') patchTurn(id, { phase: 'failed', message: v.message }, { unseen });
}

/**
 * Sends a question and follows it until it is answered, fails or a newer question replaces it. `text` is what the
 * visitor typed and what the thread shows; `send` is what goes to the server (see `composeQuestion`).
 */
export async function ask(qc: QueryClient, o: { text: string; send: string; taste: TasteSummary | null; nearMe: boolean; token: string | null }) {
  const me = ++run;
  const id = ++turnId;
  const turn: Turn = { id, question: o.text.trim(), phase: 'sending', startedAt: Date.now(), picks: [], note: '', near: false, message: null };
  set({ turns: [...state.turns, turn].slice(-MAX_TURNS), error: null, draft: null });
  let v: AskView;
  try {
    v = await api<AskView>('/ask', { method: 'POST', json: { text: o.send, ...(o.taste ? { taste: o.taste } : {}), near_me: o.nearMe, ...(o.token ? { turnstile_token: o.token } : {}) } });
  } catch (e) {
    if (me !== run) return;
    const err = e instanceof ApiError ? e : null;
    if (err && (err.code === 'ask_limit' || err.code === 'ask_resting')) {
      qc.setQueryData<AskStatus>(['ask', 'status'], s => s && { ...s, left: 0, resting: err.code === 'ask_resting' || s.resting });
      return patchTurn(id, { phase: 'failed', message: err.message }, { blocked: true });
    }
    // a mistake the visitor can fix (empty question, bot check): the message goes back to the box with the reason
    return set({ turns: state.turns.filter(t => t.id !== id), error: e instanceof Error ? e.message : 'Something went wrong. Try again.', draft: o.text });
  }
  if (me !== run) return;
  apply(id, v, qc);
  let misses = 0;
  while (me === run && v.status === 'pending') {
    await sleep(v.poll_ms);
    if (me !== run) return;
    try {
      v = await api<AskView>(`/ask/${v.id}`);
      misses = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return patchTurn(id, { phase: 'failed', message: e.message });
      if (++misses >= GIVE_UP) return patchTurn(id, { phase: 'failed', message: 'Could not reach Spotted. Check your connection and ask again. The filters and For you still work.' });
      continue;
    }
    if (me !== run) return;
    if (v.status === 'pending') continue;
    apply(id, v, qc);
  }
}

/** A new chat: forgets the thread (the window stays as it is). A question being answered is let go. */
export const clearAsk = () => { run++; set({ turns: [], error: null, draft: null, unseen: false }); };
/** Takes the error away, and the text that came back with it once it is in the box. */
export const clearAskError = () => { if (state.error || state.draft !== null) set({ error: null, draft: null }); };
