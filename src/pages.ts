// Tiny server-rendered pages: the magic-link confirm step, and a dev landing page
// to try sign in before the real front end exists.

import { Hono, type Context } from 'hono';
import { html, raw } from 'hono/html';
import type { AppEnv } from './types';
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

/** Dev landing page until the front end exists. */
pages.get('/', c => {
  noStore(c);
  const u = c.get('user');
  const err = c.req.query('login_error');
  if (u) {
    return c.html(shell('Spotted London', html`
      <h1>Hi ${u.display_name ?? 'there'}</h1>
      <p>You are signed in as <b>${u.email}</b>. Karma ${u.karma}.</p>
      <button class="btn" id="out">Sign out</button>
      <script>document.getElementById('out').onclick=async()=>{await fetch('/api/v1/auth/logout',{method:'POST'});location.reload()}</script>`));
  }
  return c.html(shell('Sign in to Spotted London', html`
    <h1>Sign in</h1>
    <p>No password. We email you a link.</p>
    ${err ? html`<p class="err">Sign in did not finish (${err}). Try again.</p>` : ''}
    <form id="f"><input id="e" type="email" required placeholder="you@email.com" autocomplete="email"><button class="btn">Email me a link</button></form>
    <a class="btn alt" href="/api/v1/auth/google">Continue with Google</a>
    <p class="out" id="o" style="margin:14px 0 0"></p>
    <script>${raw(`document.getElementById('f').onsubmit=async e=>{e.preventDefault();const o=document.getElementById('o');
      const r=await fetch('/api/v1/auth/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('e').value})});
      const j=await r.json();o.textContent='';if(j.dev_link){const a=document.createElement('a');a.href=j.dev_link;a.textContent='Dev: open sign-in link';o.append(j.message+' ',a)}else o.textContent=j.message||j.error?.message}`)}</script>`));
});
