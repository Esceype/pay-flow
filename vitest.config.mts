import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two projects, split by what they need to run:
//
//   unit         `npm test` — pure logic, no database, no network. Fast
//                enough to run on every change.
//   integration  `npm run test:integration` — the webhook route and the
//                worker's processors against a real Postgres (the ordering
//                and idempotency guarantees live in SQL, so mocking the
//                database would test nothing). Needs `docker compose up -d
//                postgres`; uses its own `payflow_test` database.

// The whole environment the integration tests run in, fixed here rather
// than read from .env: Vitest doesn't load .env into process.env, so the
// tests can never reach the development database or a real Stripe key by
// accident. Set TEST_DATABASE_URL to point at another Postgres (CI).
const integrationEnv = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/payflow_test?schema=public",
  // Never connected to: the tests replace the queue with a fake.
  REDIS_URL: "redis://localhost:6379",
  // Only used for webhook signature math and mocked calls — no network.
  STRIPE_SECRET_KEY: "sk_test_integration_dummy",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_integration_test_secret",
  NEXTAUTH_SECRET: "integration-test-secret",
  NEXTAUTH_URL: "http://localhost:3000",
  PLATFORM_FEE_BPS: "250",
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
        },
      },
    ],
  },
});
