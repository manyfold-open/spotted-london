// What someone was doing when the sign-in sheet opened, and how it is read back after Google sends them home.
// Plain functions with no imports, so the Worker tests and the web app (web/src/lib/gate.ts) run the same code.

/** An action to finish after sign in. Only quality votes: one request, safe to repeat for the person. */
export type GateIntent = { type: 'quality'; id: string; value: number };
export interface GateAsk { why: string; /** what to say after sign in when there is nothing to finish, like "vote" */ then?: string; intent?: GateIntent }

/** Older than this and it is ignored: they probably did not come back for it. */
export const GATE_FRESH_MS = 15 * 60_000;

/** Reads the stored text. Returns null for anything that is missing, odd or too old. */
export function parseGate(raw: string | null, now: number): GateAsk | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { at?: number; why?: unknown; then?: unknown; intent?: { type?: unknown; id?: unknown; value?: unknown } };
    if (typeof v.at !== 'number' || now - v.at > GATE_FRESH_MS || now < v.at) return null;
    const ask: GateAsk = { why: typeof v.why === 'string' ? v.why.slice(0, 120) : '' };
    if (typeof v.then === 'string') ask.then = v.then.slice(0, 60);
    const i = v.intent;
    if (i && i.type === 'quality' && typeof i.id === 'string' && i.id.length <= 64 && (i.value === 1 || i.value === -1 || i.value === 0)) {
      ask.intent = { type: 'quality', id: i.id, value: i.value };
    }
    return ask;
  } catch { return null; }
}
