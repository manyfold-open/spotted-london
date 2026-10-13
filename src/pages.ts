// Server-rendered bits: the magic-link confirm step and share/SEO tags for pop-up pages.
// Everything else is the single-page app in web/.

import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, PopupRow } from './types';
import { consumeMagicToken, startSession, userForEmail } from './routes/auth';
import { safeReturnTo } from './lib/auth';
import { ApiError } from './lib/util';
import { appBase, publicBase } from './middleware';
import { llmsText } from './lib/llms';
import { privacyBody } from './privacy';
import { snapshotItems } from './db/snapshot';

export const pages = new Hono<AppEnv>();

const shell = (title: string, body: unknown, wide = false) => html`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#f4efe6"><title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Instrument+Sans:wght@400;600&display=swap">
<style>
  :root{--paper:#f4efe6;--dot:#d6cbb9;--card:#fffdf8;--ink:#1d1b18;--ink2:#48423a;--accent:#e8622c;--err:#a8200d;--err-bg:#fde8e6}
  *{box-sizing:border-box}
  ::selection{background:var(--accent);color:var(--card)}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper) radial-gradient(var(--dot) 1.1px,transparent 1.2px) 0 0/22px 22px;color:var(--ink);font:15px/1.5 "Instrument Sans","Helvetica Neue",system-ui,sans-serif;padding:16px}
  main{width:100%;max-width:400px;background:var(--card);border:1.5px solid var(--ink);border-radius:16px;box-shadow:4px 4px 0 var(--ink);padding:28px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;font:800 22px/1 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.4px}
  .logo{width:36px;height:36px;border-radius:50%;border:2px solid var(--ink);background:var(--accent);display:grid;place-items:center;box-shadow:3px 3px 0 var(--ink)}
  .logo svg{width:72%;height:72%;fill:var(--card)}
  h1{margin:0 0 8px;font:800 26px/1.15 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.4px} p{margin:0 0 18px;color:var(--ink2)}
  .btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:44px;border-radius:999px;border:1.5px solid var(--ink);background:var(--ink);color:var(--card);font:inherit;font-weight:600;cursor:pointer;box-shadow:3px 3px 0 var(--accent);text-decoration:none;transition:translate .12s,box-shadow .12s}
  .btn:hover{translate:-1px -1px;box-shadow:4px 4px 0 var(--accent)} .btn:active{translate:2px 2px;box-shadow:1px 1px 0 var(--accent)}
  .btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
  .btn.alt{background:var(--card);color:var(--ink);box-shadow:none;margin-top:10px}
  .btn.alt:hover{box-shadow:3px 3px 0 var(--ink)}
  input{width:100%;min-height:44px;border-radius:12px;border:1.5px solid var(--ink);padding:0 14px;font:inherit;margin-bottom:10px;background:var(--card)}
  .err{background:var(--err-bg);color:var(--err);border-radius:12px;padding:10px 12px}
  .out{word-break:break-all;font-size:13px}
  body:has(main.wide){place-items:start center}
  main.wide{max-width:680px;margin:16px 0}
  main.wide h1{font-size:30px} main.wide h2{font:800 18px/1.3 "Bricolage Grotesque",system-ui,sans-serif;margin:26px 0 6px}
  main.wide p{margin:0 0 12px} main.wide ul{margin:0 0 12px;padding-left:20px} main.wide li{margin-bottom:8px;color:var(--ink2)} main.wide a{color:var(--ink)}
  main.wide .meta{font-size:13px;margin-bottom:16px}
</style></head><body><main class="${wide ? 'wide' : ''}">
<div class="brand"><span class="logo"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 12c-8.3 0-14.5 6-14.5 13.9C17.5 36 32 51 32 51s14.5-15 14.5-25.1C46.5 18 40.3 12 32 12zm0 19.2a5.4 5.4 0 1 1 0-10.8 5.4 5.4 0 0 1 0 10.8z"/></svg></span>Spotted</div>
${body}</main></body></html>`;

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

/** The privacy policy. Plain HTML so Google's checks and crawlers can read it without running JavaScript. */
pages.get('/privacy', c => c.html(shell('Privacy · Spotted London', privacyBody(appBase(c)), true), 200, { 'cache-control': 'public, max-age=3600' }));

/** A guide for AI assistants (llmstxt.org). Cached for an hour: it only changes with a deploy. */
pages.get('/llms.txt', c => c.text(llmsText(appBase(c)), 200, { 'cache-control': 'public, max-age=3600', 'content-type': 'text/plain; charset=utf-8' }));

/** What search engines may crawl. The API stays closed, except photos, which share previews and Google Images use. */
export function robotsText(origin: string): string {
  return ['User-agent: *', 'Allow: /', 'Allow: /api/v1/images/', 'Disallow: /api/', 'Disallow: /login/', 'Disallow: /admin', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
}

/** The home page, the guide pages and every pop-up on the public list. Read from the stored list, not from `popups`. */
export function sitemapXml(origin: string, slugs: string[]): string {
  const urls = [`${origin}/`, `${origin}/connect`, `${origin}/privacy`, ...slugs.map(s => `${origin}/p/${encodeURIComponent(s)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
}

pages.get('/robots.txt', c => c.text(robotsText(appBase(c)), 200, { 'cache-control': 'public, max-age=3600' }));

pages.get('/sitemap.xml', async c => {
  const items = await snapshotItems(c.env.DB, c.get('now'));
  const xml = sitemapXml(appBase(c), items.filter(i => !i.example).map(i => i.slug));
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
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
    .on('head', { element: e => { e.append(headTags(p, publicBase(c)) + (p.is_example ? '<meta name="robots" content="noindex">' : ''), { html: true }); } })
    .transform(shellRes);
});

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

function describe(p: PopupRow): string {
  const day = new Date(p.start_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const when = p.date_kind === 'undated' ? 'Dates not announced' : p.date_kind === 'open_end' ? `From ${day}, no end date announced` : day;
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
    // Stand-in dates (migration 0026) are not announced dates, so they are not given to search engines.
    startDate: p.date_kind === 'undated' ? undefined : new Date(p.start_at).toISOString(),
    endDate: p.date_kind === 'undated' || p.date_kind === 'open_end' ? undefined : new Date(p.end_at).toISOString(),
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
