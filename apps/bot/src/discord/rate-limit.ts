interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface BotRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

const buckets = new Map<string, RateLimitBucket>();
let nextPruneAt = Number.POSITIVE_INFINITY;

/**
 * Remove expired buckets so a long-lived bot does not retain one map entry per
 * user/guild that has ever used a privileged command. Returns the number of
 * removed buckets.
 */
export function pruneBotRateLimits(now: number = Date.now()): number {
  let pruned = 0;
  let earliestResetAt = Number.POSITIVE_INFINITY;
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(bucketKey);
      pruned += 1;
    } else if (bucket.resetAt < earliestResetAt) {
      earliestResetAt = bucket.resetAt;
    }
  }
  nextPruneAt = earliestResetAt;
  return pruned;
}

/** Reset all bot rate-limit buckets (used by tests). */
export function clearBotRateLimits(): void {
  buckets.clear();
  nextPruneAt = Number.POSITIVE_INFINITY;
}

/** Small in-process fixed-window limiter for privileged bot commands. */
export function checkBotRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): BotRateLimitResult {
  if (now >= nextPruneAt) pruneBotRateLimits(now);

  const existing = buckets.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    if (resetAt < nextPruneAt) nextPruneAt = resetAt;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
