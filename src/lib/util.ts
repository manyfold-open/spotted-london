import { HTTPException } from 'hono/http-exception';

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export function slugify(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60);
  return `${base || 'pop-up'}-${newId().slice(0, 6)}`;
}

/** Share of meaningful words in common, relative to the shorter title (0 to 1). */
export function titleSimilarity(a: string, b: string): number {
  const stop = new Set(['pop', 'popup', 'up', 'the', 'and', 'london', 'by', 'at', 'of']);
  const words = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)),
  );
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach(w => { if (B.has(w)) n++; });
  return n / Math.min(A.size, B.size);
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Error with a stable machine-readable code (SPEC §7 error format). */
export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 501 | 502, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(status, { message });
  }
}

export const bad = (code: string, message: string) => new ApiError(400, code, message);
