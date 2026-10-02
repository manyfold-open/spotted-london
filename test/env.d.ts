declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    AGENTS_KEY: string;
    AGENT_ADMIN_TOKEN: string;
  }
}
