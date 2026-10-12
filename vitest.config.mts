import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two projects, split by what they need to run:
//
//   unit         `npm test` — pure logic, no database, no network. Fast
//                enough to run on every change.
//   integration  `npm run test:integration` — the webhook route and the
//                worker against a real Postgres and a real Redis (the
//                ordering and idempotency guarantees live in SQL, the rate
//                limiter in a Lua script — mocking either would test
//                nothing). Needs `docker compose up -d postgres redis`;
//                uses its own `payflow_test` database and Redis db 15.

// The whole environment the integration tests run in, fixed here rather
// than read from .env: Vitest doesn't load .env into process.env, so the
// tests can never reach the development database or a real Stripe key by
// accident. Set TEST_DATABASE_URL / TEST_REDIS_URL to point elsewhere (CI).
const integrationEnv = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/payflow_test?schema=public",
  // Cache and rate limiter only, on logical db 15 (test/redis.ts). The
  // queues are replaced with fakes, so no job ever reaches a real queue.
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379",
  // Only used for webhook signature math and mocked calls — no network.
  STRIPE_SECRET_KEY: "sk_test_integration_dummy",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_integration_test_secret",
  NEXTAUTH_SECRET: "integration-test-secret",
  NEXTAUTH_URL: "http://localhost:3000",
  PLATFORM_FEE_BPS: "250",
  // Short, so the "Redis hangs" test doesn't take the production 2s.
  WEBHOOK_ENQUEUE_TIMEOUT_MS: "300",
};

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          setupFiles: ["./test/integration/setup.ts"],
          env: integrationEnv,
          // One database shared by every file, truncated between tests.
          fileParallelism: false,
          // The first test of each file also pays for opening the database
          // and Redis connections; on a busy machine or CI runner that
          // alone can pass the default 5s.
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
