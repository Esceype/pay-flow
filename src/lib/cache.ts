import { getCacheRedis } from "./redis";

// A cache that can only ever make a request faster, never make it fail.
// Every operation swallows Redis errors (down, slow, misbehaving) and
// reports a miss / does nothing instead, so callers don't need their own
// try/catch — they just fall through to the source of truth.
//
// Values are JSON. Every key gets a TTL: this Redis instance also backs the
// job queue and runs with `noeviction`, so nothing here may live forever.

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getCacheRedis().get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch (err) {
    console.error(`[cache] get ${key} failed`, (err as Error).message);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getCacheRedis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    console.error(`[cache] set ${key} failed`, (err as Error).message);
  }
}

// Returns whether the delete reached Redis. Invalidation is the one
// operation where a caller may care: a failed delete leaves a stale entry
// behind until its TTL runs out.
export async function cacheDelete(key: string): Promise<boolean> {
  try {
    await getCacheRedis().del(key);
    return true;
  } catch (err) {
    console.error(`[cache] delete ${key} failed`, (err as Error).message);
    return false;
  }
}
