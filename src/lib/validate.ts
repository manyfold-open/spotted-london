import { bad } from './util';

type Obj = Record<string, unknown>;

export async function jsonBody(req: { json: () => Promise<unknown> }): Promise<Obj> {
  let b: unknown;
  try { b = await req.json(); } catch { throw bad('invalid_json', 'The request body must be JSON.'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('invalid_json', 'The request body must be a JSON object.');
  return b as Obj;
}

export function text(o: Obj, key: string, opts: { min?: number; max: number; required?: boolean }): string | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw bad(`${key}_required`, `${label(key)} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${key}_invalid`, `${label(key)} must be text.`);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw bad(`${key}_too_short`, `${label(key)} needs at least ${opts.min} characters.`);
  if (s.length > opts.max) throw bad(`${key}_too_long`, `${label(key)} can be at most ${opts.max} characters.`);
  return s || null;
}

export function num(o: Obj, key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw bad(`${key}_required`, `${label(key)} is required.`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw bad(`${key}_invalid`, `${label(key)} must be a number.`);
  if (opts.min !== undefined && n < opts.min) throw bad(`${key}_invalid`, `${label(key)} is too small.`);
  if (opts.max !== undefined && n > opts.max) throw bad(`${key}_invalid`, `${label(key)} is too large.`);
  return n;
}

export function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], opts: { required?: boolean } = {}): T | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw bad(`${key}_required`, `${label(key)} is required.`);
    return null;
  }
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw bad(`${key}_invalid`, `${label(key)} must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

const label = (k: string) => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
