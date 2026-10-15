import { Hono, type Context } from 'hono';
import type { AppEnv, Bindings } from '../types';
import { requireUser } from '../middleware';
import { ApiError, bad, sha256 } from '../lib/util';
import { jsonBody, text } from '../lib/validate';
import { DAY } from '../lib/scoring';
import { resolveImageUrl } from '../lib/photo';
import { londonDateString } from '../lib/time';
import { classifyAutofillError } from '../lib/health';
import { recordAutofill } from '../db/health';
import { safeErrorText } from '../lib/a2a';
import {
  emptyExtraction, finalise, fromLlm, llmPrompt, llmVisionPrompt, LLM_SCHEMA, mergeInto, missing, parseJsonLdEvent,
  parseOpenGraph, platformOf, readableText, safeUrl, type Extracted, type Source,
} from '../lib/extract';

export const extract = new Hono<AppEnv>();

const MAX_HTML = 1_000_000;

/**
 * POST /extract  { url } or { text }
 * Returns form fields with per-field confidence. Never creates a pop-up (SPEC §3.8).
 */
extract.post('/', c => withHealth(c, async h => {
  const u = requireUser(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const rawUrl = text(b, 'url', { max: 1000 });
  const pasted = text(b, 'text', { max: 8000 });
  if (!rawUrl && !pasted) throw bad('input_required', 'Paste a link or the post text.');

  const url = rawUrl ? safeUrl(rawUrl) : null;
  if (rawUrl && !url) throw bad('url_invalid', 'That does not look like a public web link.');
  await rateLimit(c.env, u.id, now, now - u.created_at < 7 * DAY ? 3 : 10);

  if (pasted && !url) return c.json({ fields: await extractFromText(c.env, pasted, now), platform: null, cached: false });

  if (!url) throw bad('url_invalid', 'That does not look like a public web link.');
  const key = `ex:${await sha256(url.toString())}`;
  const hit = await c.env.CACHE.get<Extracted>(key, 'json');
  if (hit) { h.skip(); return c.json({ fields: hit, platform: platformOf(url), cached: true }); }

  const html = await fetchPage(url);
  const e = emptyExtraction();
  mergeInto(e, parseJsonLdEvent(html, now), 'json_ld', 'high');
  // Open Graph titles on social posts are often "Name on Instagram: caption", so ask for a check.
  mergeInto(e, parseOpenGraph(html), 'og', platformOf(url) === 'web' || platformOf(url) === 'eventbrite' ? 'high' : 'check');
  if (missing(e).length && c.env.AI) {
    const og = parseOpenGraph(html);
    const page = [og.title, og.description, readableText(html)].filter(Boolean).join('\n');
    h.aiFailed = await llmPass(c.env, e, c.env.AI_TEXT_MODEL, llmPrompt(page.slice(0, 8000), now), 'llm_text');
  }
  finalise(e, readableText(html, 2000), now);
  if (!e.title && !e.start_date) {
    throw new ApiError(422, 'unreadable_link', 'We could not find pop-up details at that link. Paste the post text, upload a screenshot, or fill in the form yourself.');
  }
  e.image_url = resolveImageUrl(e.image_url, url.toString()); // the form copies it, so it must be an absolute public address
  await c.env.CACHE.put(key, JSON.stringify(e), { expirationTtl: 86_400 });
  return c.json({ fields: e, platform: platformOf(url), cached: false });
}));

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE = 2 * 1024 * 1024;

/**
 * POST /extract/image  raw image body (JPEG, PNG or WebP, up to 2 MB)
 * Reads a screenshot of a post with the vision model. The web app shrinks screenshots first.
 */
extract.post('/image', c => withHealth(c, async () => {
  const u = requireUser(c);
  const now = c.get('now');
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(type)) throw new ApiError(415, 'image_type', 'Screenshots must be JPEG, PNG or WebP.');
  if (Number(c.req.header('content-length') ?? 0) > MAX_IMAGE) throw tooLarge();
  if (!c.env.AI) throw new ApiError(501, 'vision_not_enabled', 'Reading screenshots is not switched on yet. Paste the post text or fill in the form yourself.');
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_IMAGE) throw tooLarge();
  if (!body.byteLength) throw bad('image_empty', 'The screenshot is empty. Try taking it again.');
  await rateLimit(c.env, u.id, now, now - u.created_at < 7 * DAY ? 3 : 10);

  const e = emptyExtraction();
  const fail = await llmPass(c.env, e, c.env.AI_VISION_MODEL, llmVisionPrompt(`data:${type};base64,${base64(body)}`, now), 'llm_vision');
  if (fail) throw aiError(fail);
  finalise(e, '', now);
  if (!e.title && !e.start_date && !e.address) {
    throw new ApiError(422, 'unreadable_image', 'We could not read pop-up details in that screenshot. Try one that shows the caption, or fill in the form yourself.');
  }
  return c.json({ fields: e, platform: null, cached: false });
}));

const tooLarge = () => new ApiError(413, 'image_too_large', 'That screenshot is too big. Crop it to the post and try again.');

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function fetchPage(url: URL): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { 'user-agent': 'SpottedLondonBot/0.1 (+https://spotted.london/bot)', accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(502, 'fetch_failed', 'That page did not respond. Paste the post text instead.');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/html/i.test(type)) {
    throw new ApiError(422, 'unreadable_link', 'That site blocked us from reading the page. Paste the post text or upload a screenshot instead.');
  }
  // Read at most MAX_HTML bytes.
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_HTML) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) { buf.set(ch.subarray(0, Math.min(ch.byteLength, size - off)), off); off += ch.byteLength; }
  return new TextDecoder().decode(buf);
}

type AiFailure = 'quota' | 'error';

/** Pasted text through the model. Shared by POST /extract and the admin's autofill test (src/routes/health.ts). */
export async function extractFromText(env: Bindings, pasted: string, now: number): Promise<Extracted> {
  if (!env.AI) throw new ApiError(501, 'ai_unavailable', 'Reading pasted text needs AI, which is not switched on yet. Fill in the form yourself.');
  const e = emptyExtraction();
  const fail = await llmPass(env, e, env.AI_TEXT_MODEL, llmPrompt(pasted.slice(0, 8000), now), 'llm_text');
  if (fail) throw aiError(fail);
  finalise(e, pasted, now);
  if (!e.title && !e.start_date && !e.address) {
    throw new ApiError(422, 'unreadable_text', 'We could not find a name, date or place in that text. Paste more of the post, or fill in the form yourself.');
  }
  return e;
}

interface HealthHandle {
  /** This request says nothing about the AI (an answer from the cache): leave it out of the numbers. */
  skip(): void;
  /** The model failed on a page that then gave nothing: that is ours, not the site's. */
  aiFailed: AiFailure | null;
}

/** Counts how the request ended in the daily health numbers (src/db/health.ts), after the response has gone out. */
async function withHealth(c: Context<AppEnv>, run: (h: HealthHandle) => Promise<Response>): Promise<Response> {
  const started = Date.now();
  const h: HealthHandle & { skipped: boolean } = { skipped: false, skip() { this.skipped = true; }, aiFailed: null };
  const record = (outcome: Parameters<typeof recordAutofill>[2], error?: string) => {
    if (h.skipped) return;
    const p = recordAutofill(c.env.DB, c.get('now'), outcome, Date.now() - started, error);
    try { c.executionCtx.waitUntil(p); } catch { /* no execution context (some tests): the write still runs */ }
  };
  try {
    const res = await run(h);
    record('ok');
    return res;
  } catch (e) {
    const outcome = h.aiFailed && e instanceof ApiError && e.code === 'unreadable_link' ? 'failed' : classifyAutofillError(e);
    if (outcome) record(outcome, outcome === 'failed' ? (h.aiFailed ? `ai_${h.aiFailed}` : e instanceof ApiError ? e.code : safeErrorText(e)) : undefined);
    throw e;
  }
}


/** One model call. Fills empty fields and returns why it failed, if it did. */
async function llmPass(env: Bindings, e: Extracted, model: string, messages: unknown[], source: Source): Promise<AiFailure | null> {
  if (!env.AI) return 'error';
  let out: unknown;
  try {
    const r = await env.AI.run(model as Parameters<Ai['run']>[0], {
      messages,
      response_format: { type: 'json_schema', json_schema: LLM_SCHEMA },
      max_tokens: 700,
    } as never) as { response?: unknown };
    out = r?.response ?? r;
  } catch (err) {
    console.error('extract llm failed', model, err);
    // Workers AI error 4006: the account used up today's free neurons.
    return /4006|neurons|daily free allocation/i.test(String(err)) ? 'quota' : 'error';
  }
  const { fields, unsure } = fromLlm(out);
  const before = new Set(Object.keys(e.confidence));
  mergeInto(e, fields, source, 'high');
  for (const f of unsure) if (!before.has(f) && f in e.confidence) (e.confidence as Record<string, string>)[f] = 'check';
  return null;
}

function aiError(f: AiFailure) {
  return f === 'quota'
    ? new ApiError(503, 'ai_quota', 'Autofill has reached its limit for today. Fill in the form yourself, or try again tomorrow.')
    : new ApiError(503, 'ai_failed', 'Autofill did not work this time. Try again, or fill in the form yourself.');
}

async function rateLimit(env: Bindings, userId: string, now: number, cap: number) {
  const key = `rl:extract:${userId}:${londonDateString(now)}`;
  const used = Number((await env.CACHE.get(key)) ?? 0);
  if (used >= cap) throw new ApiError(429, 'daily_limit', `You can autofill ${cap} times a day. Fill in the form yourself, or try again tomorrow.`);
  await env.CACHE.put(key, String(used + 1), { expirationTtl: 2 * 86_400 });
}
