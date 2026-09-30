import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Bindings } from './types';
import { session } from './middleware';
import { ApiError } from './lib/util';
import { popups } from './routes/popups';
import { extract } from './routes/extract';
import { me } from './routes/me';
import { admin } from './routes/admin';
import { images, newsletter, users } from './routes/misc';
import { runCron } from './cron';

const app = new Hono<AppEnv>().basePath('/api/v1');

app.use('*', session);

app.get('/health', c => c.json({ ok: true }));
app.route('/popups', popups);
app.route('/extract', extract);
app.route('/me', me);
app.route('/users', users);
app.route('/admin', admin);
app.route('/newsletter', newsletter);
app.route('/images', images);

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
