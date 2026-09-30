import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'development', APP_URL: 'http://spotted.test', IP_SALT: 'test-salt',
            GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
