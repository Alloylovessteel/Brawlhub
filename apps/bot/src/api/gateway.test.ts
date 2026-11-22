import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readOfficialCache,
  readOfficialCachePolicy,
  resetOfficialApiCacheForTests,
  writeOfficialCache,
} from './gateway';

const POLICY_ENV = [
  'BRAWL_STARS_SUCCESS_CACHE_MS',
  'BRAWL_STARS_NEGATIVE_CACHE_MS',
  'BRAWL_STARS_TIMEOUT_MS',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

type PolicyEnv = (typeof POLICY_ENV)[number];
const originalEnv = new Map<PolicyEnv, string | undefined>();

beforeEach(() => {
  for (const key of POLICY_ENV) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetOfficialApiCacheForTests();
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetOfficialApiCacheForTests();
});

describe('readOfficialCachePolicy', () => {
  it('uses short negative TTL, 30s success TTL and the shared timeout by default', () => {
    expect(readOfficialCachePolicy()).toEqual({
      successTtlMs: 30_000,
      negativeTtlMs: 5_000,
      timeoutMs: 30_000,
    });
  });

  it('reads safe overrides from the environment', () => {
    process.env.BRAWL_STARS_SUCCESS_CACHE_MS = '4500';
    process.env.BRAWL_STARS_NEGATIVE_CACHE_MS = '250';
    process.env.BRAWL_STARS_TIMEOUT_MS = '1200';
    expect(readOfficialCachePolicy()).toEqual({
      successTtlMs: 4_500,
      negativeTtlMs: 250,
      timeoutMs: 1_200,
    });

    process.env.BRAWL_STARS_NEGATIVE_CACHE_MS = 'nonsense';
    expect(readOfficialCachePolicy().negativeTtlMs).toBe(5_000);
  });
});

describe('official API cache', () => {
  it('stores successes under a guild-scoped key', async () => {
    await writeOfficialCache('#2C0Y', 'clubs/live', { include: 'members' }, 'guild-1', {
      kind: 'success',
      payload: { trophies: 1234 },
    });

    await expect(
      readOfficialCache<{ trophies: number }>('2c0y', 'clubs/live', { include: 'members' }, 'guild-1'),
    ).resolves.toMatchObject({ kind: 'success', payload: { trophies: 1234 } });
    await expect(
      readOfficialCache('#2C0Y', 'clubs/live', { include: 'members' }, 'guild-2'),
    ).resolves.toBeNull();
    await expect(
      readOfficialCache('#2C0Y', 'clubs/live', { include: 'members' }),
    ).resolves.toBeNull();
  });

  it('keeps failures short-lived and distinct from successes', async () => {
    process.env.BRAWL_STARS_NEGATIVE_CACHE_MS = '40';
    process.env.BRAWL_STARS_SUCCESS_CACHE_MS = '60_000';

    await writeOfficialCache('#2C0Y', 'clubs/live', {}, 'guild-1', {
      kind: 'failure',
      status: 429,
      lastError: 'rate limited',
    });

    const cached = await readOfficialCache('#2C0Y', 'clubs/live', {}, 'guild-1');
    expect(cached).toMatchObject({ kind: 'failure', status: 429, lastError: 'rate limited' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(readOfficialCache('#2C0Y', 'clubs/live', {}, 'guild-1')).resolves.toBeNull();
  });

  it('does not expose raw secrets in cached error text', async () => {
    await writeOfficialCache(null, 'events/rotation', {}, null, {
      kind: 'failure',
      status: 401,
      lastError: 'Authorization: Bearer super-secret-token',
    });

    const cached = await readOfficialCache(null, 'events/rotation', {}, null);
    expect(cached).toMatchObject({ kind: 'failure', status: 401 });
    expect(JSON.stringify(cached)).not.toContain('super-secret-token');
  });
});
