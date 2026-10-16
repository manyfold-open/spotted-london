import { parseGate, type GateAsk } from '../../../src/shared/gate';

// What someone was doing when the sign-in sheet opened. Google takes them off the page and back, so it is kept in
// sessionStorage (this tab only) and read once by Shell when they are back and signed in.

const KEY = 'spotted.gate';
export function rememberGate(ask: GateAsk) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...ask, at: Date.now() })); } catch { /* the sheet still works, it just cannot finish the action afterwards */ }
}
export function forgetGate() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}
/** The remembered action, left in place. For counting why someone is signing in without taking the action away from Shell. */
export function peekGate(): GateAsk | null {
  try { return parseGate(sessionStorage.getItem(KEY), Date.now()); } catch { return null; }
}
/** The remembered action once, then forgotten. */
export function takeGate(): GateAsk | null {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(KEY); } catch { return null; }
  forgetGate();
  return parseGate(raw, Date.now());
}
