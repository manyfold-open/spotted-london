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

const app = new Hono<AppEnv>();
app.use('*', session, sameOrigin);

const api = new Hono<AppEnv>();
api.get('/health', c => c.json({ ok: true }));
api.route('/auth', auth);
api.route('/popups', popups);
api.route('/extract', extract);
api.route('/me', me);
api.route('/users', users);
api.route('/admin/agents', agentsAdmin);
api.route('/admin', admin);
api.route('/newsletter', newsletter);
api.route('/images', images);
api.route('/geocode', geocode);
api.route('/ask', ask);

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

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(controller.cron, env));
  },
} satisfies ExportedHandler<Bindings>;
