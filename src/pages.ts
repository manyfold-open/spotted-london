// Server-rendered bits: the magic-link confirm step and share/SEO tags for pop-up pages.
// Everything else is the single-page app in web/.

import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, PopupRow } from './types';
import { consumeMagicToken, startSession, userForEmail } from './routes/auth';
import { safeReturnTo } from './lib/auth';
import { ApiError } from './lib/util';

export const pages = new Hono<AppEnv>();

const shell = (title: string, body: unknown) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title}</title>
<style>
  :root{--paper:#f4efe6;--card:#fffdf8;--ink:#1d1b18;--ink2:#48423a;--accent:#e8622c;--err:#a8200d;--err-bg:#fde8e6}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:15px/1.5 "Helvetica Neue",Arial,sans-serif;padding:16px}
  main{width:100%;max-width:400px;background:var(--card);border:1.5px solid var(--ink);border-radius:16px;box-shadow:4px 4px 0 var(--ink);padding:28px}
  h1{margin:0 0 8px;font-size:26px;letter-spacing:-.4px} p{margin:0 0 18px;color:var(--ink2)}
  .btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:44px;border-radius:999px;border:1.5px solid var(--ink);background:var(--ink);color:var(--card);font:inherit;font-weight:600;cursor:pointer;box-shadow:3px 3px 0 var(--accent);text-decoration:none}
  .btn.alt{background:var(--card);color:var(--ink);box-shadow:none;margin-top:10px}
  input{width:100%;min-height:44px;border-radius:12px;border:1.5px solid var(--ink);padding:0 14px;font:inherit;margin-bottom:10px;background:var(--card)}
  .err{background:var(--err-bg);color:var(--err);border-radius:12px;padding:10px 12px}
  .out{word-break:break-all;font-size:13px}
</style></head><body><main>${body}</main></body></html>`;

function noStore(c: Context<AppEnv>) {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
}

/** Step 1: show a button. Email scanners that open links do not press buttons. */
pages.get('/login/verify', c => {
  noStore(c);
  const token = c.req.query('token') ?? '';
  const returnTo = safeReturnTo(c.req.query('return_to'));
  return c.html(shell('Sign in', html`
    <h1>Sign in to Spotted</h1>
    <p>Tap the button to finish signing in on this device.</p>
    <form method="post" action="/login/verify">
      <input type="hidden" name="token" value="${token}">
      <input type="hidden" name="return_to" value="${returnTo}">
      <button class="btn" type="submit">Sign in</button>
    </form>`));
});

/** Step 2: use the token once, start the session, go back to where the person was. */
pages.post('/login/verify', async c => {
  noStore(c);
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const email = await consumeMagicToken(c.env.DB, token, c.get('now'));
  if (!email) {
    return c.html(shell('Link expired', html`
      <h1>This link has expired</h1>
      <p class="err">Sign-in links work once and last 15 minutes. Ask for a new one and use the latest email.</p>
      <a class="btn alt" href="/">Get a new link</a>`), 400);
  }
  try {
    const u = await userForEmail(c.env.DB, email, c.get('now'));
    await startSession(c, u.id);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'banned') {
      return c.html(shell('Account suspended', html`<h1>Account suspended</h1><p class="err">This account cannot sign in.</p>`), 403);
    }
    throw e;
  }
  return c.redirect(safeReturnTo(typeof form.return_to === 'string' ? form.return_to : null), 303);
});

/**
 * Pop-up pages get real titles, share previews and schema.org Event data, injected into the
 * SPA shell at the edge. Crawlers and link previews see them without running JavaScript.
 */
pages.get('/p/:slug', async c => {
  const shellRes = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const p = await c.env.DB.prepare(
    `SELECT p.*, (SELECT r2_key FROM popup_images i WHERE i.popup_id = p.id ORDER BY position LIMIT 1) AS cover_key
     FROM popups p WHERE p.slug = ? AND p.status IN ('community', 'verified_community', 'verified_admin', 'ended')`,
  ).bind(c.req.param('slug')).first<PopupRow & { cover_key: string | null }>();
  if (!p) return shellRes;
  return new HTMLRewriter()
    .on('title', { element: e => { e.setInnerContent(`${p.title} · Spotted London`); } })
    .on('meta[name="description"]', { element: e => { e.setAttribute('content', describe(p)); } })
    .on('head', { element: e => { e.append(headTags(p, new URL(c.req.url).origin), { html: true }); } })
    .transform(shellRes);
});

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

function describe(p: PopupRow): string {
  const when = new Date(p.start_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  return [`${when}${p.borough ? ` in ${p.borough}` : ''}.`, p.description].filter(Boolean).join(' ').slice(0, 200);
}

export function headTags(p: PopupRow & { cover_key?: string | null }, origin: string): string {
  const url = `${origin}/p/${p.slug}`;
  const image = p.cover_key ? `${origin}/api/v1/images/${p.cover_key}` : null;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: p.title,
    description: p.description ?? undefined,
    startDate: new Date(p.start_at).toISOString(),
    endDate: new Date(p.end_at).toISOString(),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: p.address ?? p.borough ?? 'London', address: { '@type': 'PostalAddress', streetAddress: p.address ?? undefined, addressLocality: 'London', addressCountry: 'GB' }, geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } },
    organizer: p.host ? { '@type': 'Organization', name: p.host } : undefined,
    image: image ?? undefined,
    isAccessibleForFree: p.price_type === 'free' ? true : undefined,
    url,
  };
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(describe(p))}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    // "<" is escaped so the JSON cannot close the script tag
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ];
  return tags.join('');
}
