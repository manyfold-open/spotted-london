import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Workers AI only runs on Cloudflare. Tests get a local stand-in and mock `run` per test.
Object.defineProperty(env, 'AI', {
  configurable: true,
  value: { run: async () => { throw new Error('env.AI.run is not mocked in this test'); } },
});
