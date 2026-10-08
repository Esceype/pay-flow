import { execSync } from "node:child_process";
import { Client } from "pg";
import type { TestProject } from "vitest/node";

// Runs once before the integration project: makes sure the test database
// exists and is migrated to the current schema, using the same migrations
// as every other environment (no `db push` shortcut — the hand-written
// migrations are part of what's under test).
export default async function setup(project: TestProject) {
  const databaseUrl = project.config.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("The integration project must set DATABASE_URL (see vitest.config.mts).");
  }

  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);

  // The tests TRUNCATE every table between cases. Refuse to do that to
  // anything that isn't unmistakably a test database.
  if (!database.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests against "${database}": the database name must end with "_test".`
    );
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need Postgres at ${url.host} (start it with "docker compose up -d postgres").`,
      { cause: err }
    );
  }
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (existing.rowCount === 0) {
      // An identifier can't be a query parameter; it was validated above.
      await admin.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await admin.end();
  }

  // prisma.config.ts loads .env with dotenv, which never overrides a
  // variable that is already set — so this DATABASE_URL wins.
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}
