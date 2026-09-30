// Prisma 7 dropped the implicit .env auto-load that used to happen based on
// schema.prisma's location — prisma.config.ts must load it explicitly, or
// env() below has nothing to read.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7: the CLI (migrate, generate, studio, ...) reads the connection
// string from here rather than from `datasource.url` in schema.prisma.
// PrismaClient itself is configured separately in src/lib/prisma.ts via the
// @prisma/adapter-pg driver adapter — the two are intentionally not the
// same code path (CLI vs. runtime).
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
