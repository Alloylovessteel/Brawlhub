import { beforeEach, describe, expect, it } from 'vitest';
import { checkBotRateLimit, clearBotRateLimits } from './rate-limit';

describe('checkBotRateLimit', () => {
  beforeEach(() => clearBotRateLimits());

  it('allows requests within the configured window', () => {
    expect(checkBotRateLimit('sync:1', 3, 60_000, 0).allowed).toBe(true);
    expect(checkBotRateLimit('sync:1', 3, 60_000, 1_000).allowed).toBe(true);
    expect(checkBotRateLimit('sync:1', 3, 60_000, 2_000).allowed).toBe(true);
  });

  it('rejects excess requests and reports retry time', () => {
    checkBotRateLimit('sync:1', 2, 60_000, 0);
    checkBotRateLimit('sync:1', 2, 60_000, 1_000);
    const result = checkBotRateLimit('sync:1', 2, 60_000, 2_000);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('starts a new window after expiry', () => {
    checkBotRateLimit('sync:1', 1, 10_000, 0);
    expect(checkBotRateLimit('sync:1', 1, 10_000, 10_001).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    checkBotRateLimit('sync:1', 1, 60_000, 0);
    expect(checkBotRateLimit('sync:2', 1, 60_000, 0).allowed).toBe(true);
  });
});
