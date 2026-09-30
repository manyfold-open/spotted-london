// Typed client for /api/v1. Errors keep the server's stable `code` and readable `message`.

export type Category = 'food' | 'fashion' | 'sample' | 'art' | 'market' | 'beauty' | 'tech' | 'other';
export type Status = 'pending' | 'community' | 'verified_community' | 'verified_admin' | 'hidden' | 'removed' | 'ended';
export type When = 'today' | 'weekend' | 'week' | 'all';

export interface MyState { saved: boolean; existence_vote: number; quality_vote: number; vote_weight?: number }

export interface Popup {
  id: string; slug: string; title: string; host: string | null; description: string | null; category: Category;
  price: { type: string | null; text: string | null };
  location: { address: string | null; borough: string | null; lat: number; lng: number };
  start_at: number; end_at: number; hours_text: string | null; source_url: string | null; status: Status;
  verification: { confidence: number; weighted_votes: number; voters: number; checkins: number };
  score: number; hot: number; cover_url: string | null; created_at: number; example?: boolean;
  distance_m?: number;
  me?: MyState | null;
  images?: { id: string; url: string }[];
  posted_by?: { id: string; name: string | null; karma: number } | null;
}

export interface Me {
  id: string; email: string; name: string | null; role: 'user' | 'organizer' | 'admin';
  karma: number; trust: number; vote_weight: number; verified_posts: number; created_at: number;
}

export interface Extracted {
  title: string | null; host: string | null; category: Category | null; address: string | null;
  start_date: string | null; end_date: string | null; hours_text: string | null; price_text: string | null;
  description: string | null; image_url: string | null;
  confidence: Partial<Record<string, 'high' | 'check'>>;
  source: string[];
}

export interface Place { label: string; name: string | null; address: string; area: string | null; lat: number; lng: number }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: Record<string, unknown>) { super(message); }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`/api/v1${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body, credentials: 'same-origin' });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const e = (body as { error?: { code: string; message: string } & Record<string, unknown> } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'network', e?.message ?? 'Something went wrong. Check your connection and try again.', e);
  }
  return body as T;
}

export interface ListParams { when: When; category?: Category | ''; verified?: boolean; q?: string; near?: [number, number]; radius_km?: number; sort?: 'distance' }

export function listQuery(p: ListParams): string {
  const q = new URLSearchParams({ when: p.when, limit: '50' });
  if (p.category) q.set('category', p.category);
  if (p.verified) q.set('verified', '1');
  if (p.q) q.set('q', p.q);
  if (p.near) q.set('near', p.near.join(','));
  if (p.radius_km) q.set('radius_km', String(p.radius_km));
  if (p.sort) q.set('sort', p.sort);
  return q.toString();
}
