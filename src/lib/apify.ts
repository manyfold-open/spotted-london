// Minimal Apify REST client (https://docs.apify.com/api/v2). The token travels in the
// Authorization header, never in a URL, so it cannot end up in logs.

const BASE = 'https://api.apify.com/v2';

export interface ApifyRun { id: string; status: string; defaultDatasetId: string | null; usageTotalUsd: number | null }
export class ApifyError extends Error {}

type F = typeof fetch | undefined;

async function call(f: F, token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const doFetch: typeof fetch = f ?? ((input, i) => fetch(input, i));
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body) headers['content-type'] = 'application/json';
  const res = await doFetch(`${BASE}${path}`, { ...init, headers });
  // The body is not copied into the error: it can echo the request.
  if (!res.ok) throw new ApifyError(`Apify answered ${res.status}.`);
  return res.json();
}

function toRun(body: unknown): ApifyRun {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d.id !== 'string' || typeof d.status !== 'string') throw new ApifyError('Apify sent an answer we could not read.');
  return {
    id: d.id,
    status: d.status,
    defaultDatasetId: typeof d.defaultDatasetId === 'string' ? d.defaultDatasetId : null,
    usageTotalUsd: typeof d.usageTotalUsd === 'number' ? d.usageTotalUsd : null,
  };
}

export async function startRun(f: F, token: string, actor: string, input: Record<string, unknown>): Promise<ApifyRun> {
  return toRun(await call(f, token, `/acts/${actor}/runs`, { method: 'POST', body: JSON.stringify(input) }));
}

export async function getRun(f: F, token: string, runId: string): Promise<ApifyRun> {
  return toRun(await call(f, token, `/actor-runs/${runId}`));
}

/** Best effort: a run that cannot be stopped still times out on Apify's side. */
export async function abortRun(f: F, token: string, runId: string): Promise<void> {
  try { await call(f, token, `/actor-runs/${runId}/abort`, { method: 'POST' }); } catch { /* ignore */ }
}

export async function getItems(f: F, token: string, datasetId: string, limit: number): Promise<unknown[]> {
  const body = await call(f, token, `/datasets/${datasetId}/items?format=json&clean=true&limit=${limit}`);
  return Array.isArray(body) ? body : [];
}

export type RunState = 'pending' | 'succeeded' | 'failed';

export function runState(status: string): RunState {
  if (status === 'SUCCEEDED') return 'succeeded';
  if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) return 'failed';
  return 'pending';
}
