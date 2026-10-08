import { afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDatabase } from "../db";

// Every integration test starts from an empty database and unmocked
// modules. The processors log what they skip and why; that is expected
// output here, so it's kept out of the test report.
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
