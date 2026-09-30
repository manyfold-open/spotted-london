// Manyfold "Connect A2A": a device-code sign-in that hands us an agent's A2A address and token.
// We start a request, the admin opens Manyfold, checks the code and approves one agent, and our
// poll receives the credentials exactly once. Endpoints: manyfold-open/manyfold,
// apps/api/src/modules/connect-a2a. Start and poll need no Manyfold credentials of our own.

import { safeErrorText } from './a2a';
import { ApiError } from './util';

export const DEFAULT_MANYFOLD_API = 'https://api.manyfold.ai';

export interface ConnectStart { requestId: string; userCode: string; authUrl: string; deviceCode: string; expiresAt: string }
export interface ConnectAgent { agentId: string; name: string; rpcUrl: string; cardUrl: string; token: string; expiresAt: string | null }
export type ConnectPoll =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; userEmail: string | null; agents: ConnectAgent[] };

const apiBase = (base: string | undefined) => {
  const root = (base || DEFAULT_MANYFOLD_API).trim().replace(/\/+$/, '');
  return root.endsWith('/api') ? root : `${root}/api`;
};

async function call<T>(base: string | undefined, path: string, body: unknown, onNotFound?: T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(base)}${path}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(502, 'manyfold_unreachable', `Could not reach Manyfold: ${safeErrorText(e)}. Try again in a minute.`);
  }
  const text = await res.text();
  if (res.status === 404 && onNotFound) return onNotFound;
  if (res.status === 429) throw new ApiError(429, 'manyfold_busy', 'Manyfold asked us to slow down. Wait a minute and try again.');
  if (!res.ok) {
    let msg = text;
    try { msg = (JSON.parse(text) as { message?: string | string[] }).message?.toString() ?? text; } catch { /* keep the raw text */ }
    throw new ApiError(502, 'manyfold_error', `Manyfold answered with HTTP ${res.status}: ${safeErrorText(msg)}`);
  }
  try { return JSON.parse(text) as T; } catch { throw new ApiError(502, 'manyfold_error', 'Manyfold sent an answer that is not JSON.'); }
}

export async function connectStart(base: string | undefined, clientName: string, clientUrl: string | null): Promise<ConnectStart> {
  const out = await call<ConnectStart>(base, '/connect/a2a/start', { clientName, ...(clientUrl ? { clientUrl } : {}) });
  if (!out.deviceCode || !out.authUrl || !/^https:\/\//.test(out.authUrl)) throw new ApiError(502, 'manyfold_error', 'Manyfold sent an incomplete sign-in request. Try again.');
  return out;
}

export function connectPoll(base: string | undefined, deviceCode: string): Promise<ConnectPoll> {
  // Manyfold deletes finished requests after an hour; an unknown device code is simply over.
  return call<ConnectPoll>(base, '/connect/a2a/poll', { deviceCode }, { status: 'expired' });
}
