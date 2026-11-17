interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitStore {
  buckets: Map<string, RateLimitBucket>;
}

const globalStore = globalThis as typeof globalThis & {
  __brawlhubRateLimitStore?: RateLimitStore;
};

const store: RateLimitStore =
  globalStore.__brawlhubRateLimitStore ?? { buckets: new Map<string, RateLimitBucket>() };
globalStore.__brawlhubRateLimitStore = store;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
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
  const existing = store.buckets.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    store.buckets.set(key, { count: 1, resetAt: now + windowMs });
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
