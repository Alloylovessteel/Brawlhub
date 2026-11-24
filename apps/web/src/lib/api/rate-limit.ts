interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitStore {
  buckets: Map<string, RateLimitBucket>;
  nextPruneAt: number;
}

const globalStore = globalThis as typeof globalThis & {
  __brawlhubRateLimitStore?: RateLimitStore;
};

const store: RateLimitStore =
  globalStore.__brawlhubRateLimitStore ?? {
    buckets: new Map<string, RateLimitBucket>(),
    nextPruneAt: Number.POSITIVE_INFINITY,
  };
if (typeof store.nextPruneAt !== 'number') {
  store.nextPruneAt = Number.POSITIVE_INFINITY;
}
globalStore.__brawlhubRateLimitStore = store;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Remove expired buckets so long-lived processes do not retain stale keys. */
export function pruneRateLimits(now: number = Date.now()): number {
  let pruned = 0;
  let earliestResetAt = Number.POSITIVE_INFINITY;
  for (const [bucketKey, bucket] of store.buckets) {
    if (bucket.resetAt <= now) {
      store.buckets.delete(bucketKey);
      pruned += 1;
    } else if (bucket.resetAt < earliestResetAt) {
      earliestResetAt = bucket.resetAt;
    }
  }
  store.nextPruneAt = earliestResetAt;
  return pruned;
}

/** Reset all web rate-limit buckets (used by tests). */
export function clearRateLimits(): void {
  store.buckets.clear();
  store.nextPruneAt = Number.POSITIVE_INFINITY;
}

/**
 * Small in-process sliding-window limiter for authenticated mutation routes.
 * Deployments with multiple instances should replace this with a shared store.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  if (now >= store.nextPruneAt) pruneRateLimits(now);

  const existing = store.buckets.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    store.buckets.set(key, { count: 1, resetAt });
    if (resetAt < store.nextPruneAt) store.nextPruneAt = resetAt;
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: 0,
  };
}
