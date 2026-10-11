import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";

// Same Redis instance, two separate logical databases: db 0 backs the
// BullMQ job queue, db 1 backs the cache and the rate limiter. This keeps
// queue keys and cache keys from colliding and lets either be flushed
// independently in development without touching the other.
//
// One instance also means one eviction policy for both. BullMQ needs
// `noeviction` (an evicted queue key is a lost job), so the cache can't
// lean on LRU eviction — every key it writes carries a TTL instead.
const REDIS_DB_QUEUE = 0;
const REDIS_DB_CACHE = 1;

let queueRedisInstance: Redis | undefined;
let cacheRedisInstance: Redis | undefined;

function createClient(db: number, options: RedisOptions) {
  return new Redis(env.REDIS_URL, { db, ...options });
}

// Lazy singletons, not eager top-level instances: constructing an ioredis
// client reads env.REDIS_URL immediately, which must not happen at
// module-import time (see env.ts) — only when something actually needs a
// connection (e.g. the worker process, or a route enqueuing a job).
export function getQueueRedis(): Redis {
  return (queueRedisInstance ??= createClient(REDIS_DB_QUEUE, {
    // Required by BullMQ on connections it manages — it handles its own
    // retry/backoff and this option must be disabled for that to work.
    maxRetriesPerRequest: null,
  }));
}

// The opposite trade-off from the queue connection. Nothing that uses this
// client is essential to a request — a cache miss reads Postgres, and the
// rate limiter fails open — so when Redis is slow or down, a command must
// fail within a fraction of a second rather than wait for it to come back
// (measured against a dead port: ~200ms here, forever with the queue
// connection's settings).
export function getCacheRedis(): Redis {
  return (cacheRedisInstance ??= createClient(REDIS_DB_CACHE, {
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 1000,
  }));
}
