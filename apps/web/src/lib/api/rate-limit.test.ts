import { describe, expect, it } from 'vitest';
import { checkRateLimit } from './rate-limit';

describe('checkRateLimit', () => {
  it('allows requests within the limit and blocks the next one', () => {
    const key = `test-${Date.now()}-allow`;
    expect(checkRateLimit(key, 2, 60_000, 1_000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 60_000, 1_100).allowed).toBe(true);
    const blocked = checkRateLimit(key, 2, 60_000, 1_200);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('starts a fresh window after expiry', () => {
    const key = `test-${Date.now()}-expiry`;
    checkRateLimit(key, 1, 1_000, 5_000);
    expect(checkRateLimit(key, 1, 1_000, 5_500).allowed).toBe(false);
    expect(checkRateLimit(key, 1, 1_000, 6_100).allowed).toBe(true);
  });
});
