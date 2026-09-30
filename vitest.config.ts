import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { ENVIRONMENT: 'development', IP_SALT: 'test-salt', TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
