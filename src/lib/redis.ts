import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";

// Same Redis instance, two separate logical databases: db 0 backs the
// BullMQ job queue, db 1 backs the read-through cache. This keeps queue
// keys and cache keys from colliding and lets either be flushed
// independently in development without touching the other.
const REDIS_DB_QUEUE = 0;
const REDIS_DB_CACHE = 1;

let queueRedisInstance: Redis | undefined;
let cacheRedisInstance: Redis | undefined;

function createClient(db: number, options: RedisOptions = {}) {
  return new Redis(env.REDIS_URL, {
    db,
    // Required by BullMQ on connections it manages — it handles its own
    // retry/backoff and this option must be disabled for that to work.
    maxRetriesPerRequest: null,
    ...options,
  });
}

// Lazy singletons, not eager top-level instances: constructing an ioredis
// client reads env.REDIS_URL immediately, which must not happen at
// module-import time (see env.ts) — only when something actually needs a
// connection (e.g. the worker process, or a route enqueuing a job).
export function getQueueRedis(): Redis {
  return (queueRedisInstance ??= createClient(REDIS_DB_QUEUE));
}

export function getCacheRedis(): Redis {
  return (cacheRedisInstance ??= createClient(REDIS_DB_CACHE));
}
