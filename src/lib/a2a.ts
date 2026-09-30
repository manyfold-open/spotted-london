// Minimal A2A client (JSON-RPC 2.0 over HTTPS) for starting and checking agent runs on Manyfold.
// Protocol handling follows manyfold-open/cloudflare-worker-launch (MIT), trimmed to what cron needs:
// a run is started with `message/stream`, we read only until the task id arrives, and later
// check on it with `tasks/get`. Holding the stream open would burn Workers CPU on every token.

import { ApiError } from './util';

export interface AgentCred { rpcUrl: string; token: string }

export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'input-required' | 'auth-required' | 'unknown';
export const FINISHED: TaskState[] = ['completed', 'failed', 'canceled', 'rejected', 'input-required', 'auth-required'];

export interface TaskInfo { taskId: string | null; state: TaskState; text: string }

/** Strips anything token-shaped before an error string is stored or shown. */
export function safeErrorText(v: unknown): string {
  return String(v instanceof Error ? v.message : v ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/\beyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{10,}\b/g, '[hidden]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[hidden]')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}

/** The A2A address an admin pastes is still checked: https only, no private hosts. */
export function checkRpcUrl(raw: string, dev: boolean): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ApiError(400, 'rpc_url_invalid', 'The A2A address is not a valid URL. Copy it again from Manyfold.'); }
  if (u.username || u.password) throw new ApiError(400, 'rpc_url_invalid', 'The A2A address must not contain a user name or password.');
  if (u.protocol !== 'https:' && !(dev && u.protocol === 'http:')) throw new ApiError(400, 'rpc_url_invalid', 'The A2A address must start with https://.');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const internal = h === 'localhost' || h.endsWith('.local') || h === '::1' || h === '0.0.0.0'
    || /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h);
  if (internal && !dev) throw new ApiError(400, 'rpc_url_invalid', 'The A2A address points at a private network.');
  u.hash = '';
  return u.toString();
}

function state(v: unknown): TaskState {
  const s = String(v ?? '').toLowerCase().replace(/^task_state_/, '').replace(/_/g, '-');
  return (['submitted', 'working', ...FINISHED] as string[]).includes(s) ? s as TaskState : 'unknown';
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).filter(Boolean).join('\n');
}

/** Reads a task, message, status-update or artifact-update result into one shape. */
export function readResult(raw: unknown, into: TaskInfo = { taskId: null, state: 'unknown', text: '' }): TaskInfo {
  if (!raw || typeof raw !== 'object') return into;
  const v = raw as Record<string, unknown>;
  const kind = String(v.kind ?? '');
  const id = (typeof v.taskId === 'string' && v.taskId) || (kind === 'task' && typeof v.id === 'string' && v.id) || null;
  if (id) into.taskId = id;
  const status = (v.status ?? {}) as Record<string, unknown>;
  const s = state(status.state ?? v.state);
  if (s !== 'unknown') into.state = s;
  const artifacts = Array.isArray(v.artifacts) ? v.artifacts : v.artifact ? [v.artifact] : [];
  const artText = artifacts.map(a => partsText((a as { parts?: unknown }).parts)).filter(Boolean).join('\n\n');
  const statusText = partsText((status.message as { parts?: unknown } | undefined)?.parts);
  const msgText = kind === 'message' ? partsText(v.parts) : '';
  // A plain message instead of a task means the agent answered and the turn is over.
  if (kind === 'message' && !into.taskId && (into.state === 'unknown' || into.state === 'submitted')) into.state = 'completed';
  into.text = artText || msgText || statusText || into.text;
  return into;
}

async function post(cred: AgentCred, method: string, params: unknown, accept: string, ms: number, probing = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(cred.rpcUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(ms),
      headers: { 'content-type': 'application/json', accept, authorization: `Bearer ${cred.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    });
  } catch (e) {
    throw new ApiError(502, 'agent_unreachable', `Could not reach the agent: ${safeErrorText(e)}. Check the A2A address and try again.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(502, 'agent_token_rejected', 'Manyfold rejected the agent token. It may have expired. Mint a new caller token in Manyfold and paste it here.');
  }
  // A probe only cares about auth: "no such task" may come back as any 4xx.
  if (!res.ok && !(probing && res.status < 500)) {
    throw new ApiError(502, 'agent_error', `The agent answered with HTTP ${res.status}: ${safeErrorText(await res.text())}`);
  }
  return res;
}

function rpcError(e: unknown): ApiError {
  const err = (e ?? {}) as { code?: number; message?: string };
  return new ApiError(502, 'agent_error', `The agent returned an error${err.code ? ` ${err.code}` : ''}: ${safeErrorText(err.message ?? JSON.stringify(e))}`);
}

/**
 * Starts one agent turn. Returns as soon as the task id is known (or the turn already finished).
 * `messageId` is A2A's idempotency key, so it is derived from our run id: a retry cannot start
 * a second billed turn.
 */
export async function startTask(cred: AgentCred, messageId: string, text: string, ms = 30_000): Promise<TaskInfo> {
  const res = await post(cred, 'message/stream', {
    message: { kind: 'message', role: 'user', messageId, parts: [{ kind: 'text', text }] },
    configuration: { acceptedOutputModes: ['text/plain'] },
  }, 'text/event-stream', ms);

  const info: TaskInfo = { taskId: null, state: 'submitted', text: '' };
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const body = await res.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
    if (body?.error) throw rpcError(body.error);
    return readResult(body?.result, info);
  }
  if (!res.body) throw new ApiError(502, 'agent_error', 'The agent sent an empty answer.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, cut).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        buf = buf.slice(cut + 2);
        if (!data || data === '[DONE]') continue;
        let env: { result?: unknown; error?: unknown };
        try { env = JSON.parse(data); } catch { continue; }
        if (env.error) throw rpcError(env.error);
        readResult(env.result, info);
        if (info.taskId || FINISHED.includes(info.state)) return info;
      }
    }
  } finally {
    // The task keeps running on Manyfold after we hang up (A2A: closing a stream does not cancel).
    reader.cancel().catch(() => {});
  }
  return info;
}

/** Current state and latest text of a task. */
export async function getTask(cred: AgentCred, taskId: string): Promise<TaskInfo> {
  const res = await post(cred, 'tasks/get', { id: taskId }, 'application/json', 20_000);
  const body = await res.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
  if (!body) throw new ApiError(502, 'agent_error', 'The agent sent an answer that is not JSON.');
  if (body.error) throw rpcError(body.error);
  return readResult(body.result, { taskId, state: 'unknown', text: '' });
}

/**
 * Checks address and token without running a turn: asks for a task that cannot exist.
 * Only an auth failure or an unreachable host counts as broken.
 */
export async function probe(cred: AgentCred): Promise<void> {
  await post(cred, 'tasks/get', { id: `probe-${crypto.randomUUID()}` }, 'application/json', 15_000, true);
}
