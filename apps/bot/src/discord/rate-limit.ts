interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface BotRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

const buckets = new Map<string, RateLimitBucket>();

/** Reset all bot rate-limit buckets (used by tests). */
export function clearBotRateLimits(): void {
  buckets.clear();
}

/** Small in-process fixed-window limiter for privileged bot commands. */
export function checkBotRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): BotRateLimitResult {
  const existing = buckets.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
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
