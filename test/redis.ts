import { Redis } from "ioredis";

// The Redis the integration tests use for the cache and the rate limiter:
// the instance from REDIS_URL, but logical database 15 — far from db 0
// (queue) and db 1 (cache) that a development stack on the same instance
// uses, because the tests FLUSHDB it between cases.
const TEST_REDIS_DB = 15;

let client: Redis | undefined;

export function getTestRedis(): Redis {
  return (client ??= new Redis(process.env.REDIS_URL!, {
    db: TEST_REDIS_DB,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 1000,
  }));
}

export async function resetRedis(): Promise<void> {
  await getTestRedis().flushdb();
}

export async function closeTestRedis(): Promise<void> {
  await client?.quit();
  client = undefined;
}

// A client pointed at a port nothing listens on, configured like the real
// cache connection: every command fails within a fraction of a second.
// For "what if Redis is down" tests. Disconnect it when done.
export function unreachableRedis(): Redis {
  const redis = new Redis({
    host: "127.0.0.1",
    port: 6399,
    maxRetriesPerRequest: 1,
    commandTimeout: 300,
    connectTimeout: 300,
  });
  redis.on("error", () => {});
  return redis;
}
