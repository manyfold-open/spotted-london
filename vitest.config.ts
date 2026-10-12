import { configDefaults, defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        // Tests never call Cloudflare: the AI binding stays local and each test mocks env.AI.run.
        remoteBindings: false,
        miniflare: {
          bindings: {
            ENVIRONMENT: 'development', APP_URL: 'http://spotted.test', IP_SALT: 'test-salt',
            GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
            AGENTS_KEY: 'test-agents-key-that-is-at-least-32-chars',
            AGENT_ADMIN_TOKEN: 'test-agent-manager-token-at-least-32-chars',
            MANYFOLD_API_URL: 'https://api.manyfold.ai',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    // css.include lets a test read web/src/styles.css as text (`?raw`). Vitest blanks CSS files by default.
    // .claude/** holds Claude Code worktrees: full copies of the repo whose tests would run too.
    test: {
      setupFiles: ['./test/setup.ts'],
      css: { include: [/styles\.css/] },
      exclude: [...configDefaults.exclude, '.claude/**'],
    },
  };
});
