import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../types';
import { requireUser } from '../middleware';
import { ApiError, bad, sha256 } from '../lib/util';
import { jsonBody, text } from '../lib/validate';
import { DAY } from '../lib/scoring';
import { londonDateString } from '../lib/time';
import {
  emptyExtraction, finalise, fromLlm, llmPrompt, LLM_SCHEMA, mergeInto, missing, parseJsonLdEvent,
  parseOpenGraph, platformOf, readableText, safeUrl, type Extracted,
} from '../lib/extract';

export const extract = new Hono<AppEnv>();

const MAX_HTML = 1_000_000;

/**
 * POST /extract  { url } or { text }
 * Returns form fields with per-field confidence. Never creates a pop-up (SPEC §3.8).
 */
extract.post('/', async c => {
  const u = requireUser(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const rawUrl = text(b, 'url', { max: 1000 });
  const pasted = text(b, 'text', { max: 8000 });
  if (!rawUrl && !pasted) throw bad('input_required', 'Paste a link or the post text.');

  const url = rawUrl ? safeUrl(rawUrl) : null;
  if (rawUrl && !url) throw bad('url_invalid', 'That does not look like a public web link.');
  await rateLimit(c.env, u.id, now, now - u.created_at < 7 * DAY ? 3 : 10);

  if (pasted && !url) {
    if (!c.env.AI) throw new ApiError(501, 'ai_unavailable', 'Reading pasted text needs AI, which is not switched on yet. Fill in the form yourself.');
    const e = emptyExtraction();
    await llmPass(c.env, e, pasted, now);
    return c.json({ fields: finalise(e, pasted, now), platform: null, cached: false });
  }

  if (!url) throw bad('url_invalid', 'That does not look like a public web link.');
  const key = `ex:${await sha256(url.toString())}`;
  const hit = await c.env.CACHE.get<Extracted>(key, 'json');
  if (hit) return c.json({ fields: hit, platform: platformOf(url), cached: true });

  const html = await fetchPage(url);
  const e = emptyExtraction();
  mergeInto(e, parseJsonLdEvent(html, now), 'json_ld', 'high');
  // Open Graph titles on social posts are often "Name on Instagram: caption", so ask for a check.
  mergeInto(e, parseOpenGraph(html), 'og', platformOf(url) === 'web' || platformOf(url) === 'eventbrite' ? 'high' : 'check');
  if (missing(e).length && c.env.AI) {
    const og = parseOpenGraph(html);
    await llmPass(c.env, e, [og.title, og.description, readableText(html)].filter(Boolean).join('\n'), now);
  }
  finalise(e, readableText(html, 2000), now);
  if (!e.title && !e.start_date) {
    throw new ApiError(422, 'unreadable_link', 'We could not find pop-up details at that link. Paste the post text, upload a screenshot, or fill in the form yourself.');
  }
  await c.env.CACHE.put(key, JSON.stringify(e), { expirationTtl: 86_400 });
  return c.json({ fields: e, platform: platformOf(url), cached: false });
});

/** Screenshots need a vision model; this is wired up once Workers AI is enabled. */
extract.post('/image', c => {
  requireUser(c);
  throw new ApiError(501, 'vision_not_enabled', 'Reading screenshots is not switched on yet. Paste the post text or fill in the form yourself.');
});

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

async function llmPass(env: Bindings, e: Extracted, input: string, now: number) {
  if (!env.AI) return;
  let out: unknown;
  try {
    const r = await env.AI.run(env.AI_TEXT_MODEL as Parameters<Ai['run']>[0], {
      messages: llmPrompt(input.slice(0, 8000), now),
      response_format: { type: 'json_schema', json_schema: LLM_SCHEMA },
      max_tokens: 700,
    } as never) as { response?: unknown };
    out = r?.response ?? r;
  } catch (err) {
    console.error('extract llm failed', err);
    return; // fall back to whatever deterministic parsing found
  }
  const { fields, unsure } = fromLlm(out);
  const before = new Set(Object.keys(e.confidence));
  mergeInto(e, fields, 'llm_text', 'high');
  for (const f of unsure) if (!before.has(f) && f in e.confidence) (e.confidence as Record<string, string>)[f] = 'check';
}

async function rateLimit(env: Bindings, userId: string, now: number, cap: number) {
  const key = `rl:extract:${userId}:${londonDateString(now)}`;
  const used = Number((await env.CACHE.get(key)) ?? 0);
  if (used >= cap) throw new ApiError(429, 'daily_limit', `You can autofill ${cap} times a day. Fill in the form yourself, or try again tomorrow.`);
  await env.CACHE.put(key, String(used + 1), { expirationTtl: 2 * 86_400 });
}
