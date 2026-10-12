import type { Redis } from "ioredis";
import { getCacheRedis } from "./redis";
import { log } from "./logger";

// Token-bucket rate limiting in Redis (ADR-008).
//
// A bucket holds up to `capacity` tokens and regains `refillPerSecond`
// tokens every second. Each request takes one; an empty bucket rejects.
// That allows a short burst (a human clicking through a form quickly)
// while capping the sustained rate (a script in a loop) — which a fixed
// "N per minute" window can't do without also allowing 2N at the boundary.

export interface RateLimitRule {
  name: string;
  capacity: number;
  refillPerSecond: number;
}

export const RATE_LIMITS = {
  // Dashboard mutations, per tenant. Each one can fan out into Stripe API
  // calls on the tenant's connected account, so this is also backpressure
  // on someone else's API: burst of 20, then one every two seconds.
  tenantAction: { name: "tenant-action", capacity: 20, refillPerSecond: 0.5 },
  // Per client address. Password checks are deliberately expensive
  // (scrypt), which makes these endpoints both a guessing target and a
  // cheap way to burn CPU.
  login: { name: "login", capacity: 10, refillPerSecond: 1 / 30 },
  signup: { name: "signup", capacity: 5, refillPerSecond: 1 / 60 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  // Whole tokens left after this request.
  remaining: number;
  // When rejected: how long until one token is available again.
  retryAfterSeconds: number;
}

// Refill and take a token in one atomic step. Done in Lua because
// read-compute-write from the application would let concurrent requests
// all read the same token count and all spend the same token.
//
// The clock is Redis' own (TIME), not the caller's: every app instance
// shares one bucket, so they must share one clock too.
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2]) / 1000

local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'refilled_at')
local tokens = tonumber(bucket[1])
local refilled_at = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  refilled_at = now
end

tokens = math.min(capacity, tokens + math.max(0, now - refilled_at) * refill_per_ms)

local allowed = 0
local retry_after_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after_ms = math.ceil((1 - tokens) / refill_per_ms)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'refilled_at', now)
-- A bucket left untouched this long would be full again anyway, so the key
-- can go: idle subjects cost no memory.
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill_per_ms))

return { allowed, math.floor(tokens), retry_after_ms }
`;

type TokenBucketClient = Redis & {
  tokenBucket(
    key: string,
    capacity: number,
    refillPerSecond: number
  ): Promise<[allowed: number, remaining: number, retryAfterMs: number]>;
};

// defineCommand makes ioredis send the script once and call it by hash
// (EVALSHA) afterwards.
function withTokenBucket(redis: Redis): TokenBucketClient {
  if (!("tokenBucket" in redis)) {
    redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  }
  return redis as TokenBucketClient;
}

// Takes one token from `subject`'s bucket for `rule`.
//
// Fails open: if Redis can't be reached the request is allowed. The limiter
// protects against abuse; it must not turn a Redis outage into an outage of
// every form in the app. (The cache connection fails within a fraction of a
// second, so this doesn't stall the request either.)
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string
): Promise<RateLimitResult> {
  try {
    const [allowed, remaining, retryAfterMs] = await withTokenBucket(getCacheRedis()).tokenBucket(
      `ratelimit:${rule.name}:${subject}`,
      rule.capacity,
      rule.refillPerSecond
    );
    return {
      allowed: allowed === 1,
      remaining,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  } catch (err) {
    log.warn("rate limiter unavailable, allowing request", { rule: rule.name, err });
    return { allowed: true, remaining: rule.capacity, retryAfterSeconds: 0 };
  }
}

// The subject for limits that apply before anyone is signed in.
//
// The left-most X-Forwarded-For entry is the client as seen by the first
// proxy. That is only trustworthy behind a proxy that sets the header
// itself (Vercel, a load balancer); reached directly, a client could send
// any value and get a fresh bucket each time. With no header at all — plain
// `docker compose up` — every client shares the "unknown" bucket.
export function clientAddress(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
