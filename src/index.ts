import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Bindings } from './types';
import { sameOrigin, session } from './middleware';
import { ApiError } from './lib/util';
import { popups } from './routes/popups';
import { extract } from './routes/extract';
import { me } from './routes/me';
import { admin } from './routes/admin';
import { images, newsletter, users } from './routes/misc';
import { runCron } from './cron';
import { auth } from './routes/auth';
import { pages } from './pages';
import { geocode } from './routes/geocode';
import { ask } from './routes/ask';
import { agentsAdmin } from './routes/agents';
import { mcp } from './mcp';
import { events } from './routes/events';
import { insights } from './routes/insights';
import { withMount } from './mount';
import { withAnalytics } from './analytics';

const app = new Hono<AppEnv>();

// At the root only the paths in wrangler.jsonc `run_worker_first` reach the Worker; the static files never do.
// Under a mount (src/mount.ts) every request does, because the prefix has to come off before the assets can be
// found. So anything that is not the Worker's own goes straight to the static files, before the session lookup
// (no database read per script or picture). Keep this list in step with `run_worker_first`.
const WORKER_PATHS = /^\/(api|mcp|login|p|privacy|llms\.txt|sitemap\.xml|robots\.txt)(\/|$)/;
app.on(['GET', 'HEAD'], '*', (c, next) => (WORKER_PATHS.test(c.req.path) ? next() : c.env.ASSETS.fetch(c.req.raw)));

app.use('*', session, sameOrigin);

const api = new Hono<AppEnv>();
api.get('/health', c => c.json({ ok: true }));
api.route('/auth', auth);
api.route('/popups', popups);
api.route('/extract', extract);
api.route('/me', me);
api.route('/users', users);
api.route('/admin/agents', agentsAdmin);
api.route('/admin/insights', insights);
api.route('/admin', admin);
api.route('/newsletter', newsletter);
api.route('/images', images);
api.route('/geocode', geocode);
api.route('/ask', ask);
api.route('/e', events);

app.route('/api/v1', api);
app.route('/mcp', mcp);
app.route('/', pages);

app.notFound(c => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
  }
  console.error(err);
  return c.json({ error: { code: 'server_error', message: 'Something went wrong on our side. Try again.' } }, 500);
});

const mounted = withMount<Bindings>((request, env, ctx) => app.fetch(request, env, ctx));

export default {
  // Pages on the public site name the Google Analytics property (src/analytics.ts). It reads the request as it arrived,
  // with its own host and Cloudflare's country.
  fetch: async (request, env, ctx) => withAnalytics(await mounted(request, env, ctx), request, env),
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(controller.cron, env));
  },
} satisfies ExportedHandler<Bindings>;
