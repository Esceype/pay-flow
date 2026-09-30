import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Standard Next.js dev singleton: without this, hot-reload would create a
// new PrismaClient (and a new connection pool) on every edit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    // Prisma 7 requires an explicit driver adapter instead of a
    // schema-level datasource.url — see prisma.config.ts for the CLI-side
    // equivalent. Constructed lazily, not at module top level: reading
    // env.DATABASE_URL at import time is exactly what breaks `next build`'s
    // page-data collection (see env.ts) — this must only happen when a
    // request actually touches the database.
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
    globalForPrisma.prisma = new PrismaClient({ adapter });
  }
  return globalForPrisma.prisma;
}

// Proxy so call sites keep the ergonomic `prisma.user.findUnique(...)`
// shape without needing to call a getter first — first property access
// triggers (and memoizes) real client construction.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient();
    const value = client[prop as keyof PrismaClient];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
