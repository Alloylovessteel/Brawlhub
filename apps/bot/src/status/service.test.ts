import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrawlStarsClient } from '@brawlhub/brawl-stars';
import type { SyncStatusView } from '../admin/types';
import { resetStatusApiCache, loadStatusView, emptySyncStatusView } from './service';
import type { BotRuntimeSnapshot } from './runtime';

const runtime: BotRuntimeSnapshot = {
  startedAt: new Date('2026-11-18T00:00:00.000Z'),
  discordReady: true,
  discordReadyAt: new Date('2026-11-18T00:00:01.000Z'),
};

function syncView(overrides: Partial<SyncStatusView> = {}): SyncStatusView {
  return {
    ...emptySyncStatusView(),
    ...overrides,
    lock: overrides.lock ?? { scope: 'all-clubs', lockedBy: null, lockedAt: null, lockedUntil: null, active: false },
    latestRun: overrides.latestRun ?? null,
    generatedAt: overrides.generatedAt ?? new Date('2026-11-18T00:02:00.000Z'),
  };
}

function dbClient(options: {
  clubsError?: boolean;
  clubTag?: string | null;
  count?: number | null;
}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        limit: vi.fn(async () => ({
          data:
            options.clubTag === undefined || options.clubTag === null
              ? []
              : [{ tag: options.clubTag }],
          error: options.clubsError ? { message: 'db error' } : null,
          count: options.count ?? null,
        })),
      })),
    })),
  } as never;
}

function apiClient(result: 'ok' | 'timeout' | 'fail'): BrawlStarsClient {
  return {
    getClub: vi.fn(async () => {
      if (result === 'timeout') throw new Error('status-api-check timed out after 5000ms');
      if (result === 'fail') throw new Error('boom');
      return { tag: '2UG9', name: 'A', trophies: 1, members: [] } as never;
    }),
    getClubMembers: vi.fn(async () => []),
    getPlayer: vi.fn(async () => ({ tag: 'P1', name: 'P', trophies: 0 }) as never),
    getBattleLog: vi.fn(async () => []),
    getBrawlers: vi.fn(async () => []),
    getEventRotation: vi.fn(async () => []),
  };
}

describe('loadStatusView', () => {
  beforeEach(() => resetStatusApiCache());

  it('reports operational when all checks are healthy', async () => {
    const view = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime,
      supabaseConfigured: true,
      db: dbClient({ clubTag: '2UG9', count: 7 }),
      apiClient: apiClient('ok'),
      apiKeyConfigured: true,
      loadSync: async () =>
        syncView({
          latestRun: {
            id: 'r1',
            status: 'completed',
            periodStart: null,
            startedAt: null,
            finishedAt: '2026-11-18T00:05:00.000Z',
            error: null,
            lastError: null,
            recordsProcessed: 10,
            affectedClubIds: [],
            clubTags: ['2UG9'],
          },
        }),
      isSyncInFlight: () => false,
    });

    expect(view.overall).toBe('operational');
    expect(view.discord.state).toBe('ok');
    expect(view.discord.uptimeMs).toBe(10 * 60_000);
    expect(view.database).toMatchObject({ state: 'ok', clubCount: 7 });
    expect(view.api.state).toBe('ok');
    expect(view.sync).toMatchObject({ state: 'ok', status: 'completed', running: false });
    expect(view.version).toMatch(/^v0\.1\.0/);
  });

  it('reports offline bot without claiming the whole system is healthy', async () => {
    const view = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime: { startedAt: runtime.startedAt, discordReady: false, discordReadyAt: null },
      supabaseConfigured: true,
      db: dbClient({ clubTag: '2UG9', count: 1 }),
      apiClient: apiClient('ok'),
      loadSync: async () => syncView(),
    });

    expect(view.overall).toBe('degraded');
    expect(view.discord.state).toBe('error');
  });

  it('reports database errors and continues with other checks', async () => {
    const view = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime,
      supabaseConfigured: true,
      db: dbClient({ clubsError: true }),
      apiClient: apiClient('ok'),
      loadSync: async () => syncView(),
    });

    expect(view.overall).toBe('degraded');
    expect(view.database.state).toBe('error');
    expect(view.api.state).toBe('unavailable');
  });

  it('reports API timeout or failure as distinct unavailable/error states', async () => {
    const timedOut = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime,
      supabaseConfigured: true,
      db: dbClient({ clubTag: '2UG9', count: 1 }),
      apiClient: apiClient('timeout'),
      apiKeyConfigured: true,
      loadSync: async () => syncView(),
    });
    expect(timedOut.api.detail).toContain('timed out');

    resetStatusApiCache();
    const failed = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:01.000Z'),
      runtime,
      supabaseConfigured: true,
      db: dbClient({ clubTag: '2UG9', count: 1 }),
      apiClient: apiClient('fail'),
      apiKeyConfigured: true,
      loadSync: async () => syncView(),
    });
    expect(failed.api.state).toBe('error');
    expect(failed.api.detail).not.toContain('boom');
  });

  it('handles missing sync history gracefully', async () => {
    const view = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime,
      supabaseConfigured: true,
      db: dbClient({ clubTag: null, count: 0 }),
      apiKeyConfigured: false,
      loadSync: async () => syncView(),
    });

    expect(view.sync).toMatchObject({ state: 'unavailable', status: null, lastTimestamp: null });
    expect(view.api.state).toBe('unavailable');
  });

  it('reflects running sync from lock state', async () => {
    const view = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime,
      supabaseConfigured: true,
      db: dbClient({ clubTag: '2UG9', count: 1 }),
      apiKeyConfigured: false,
      loadSync: async () =>
        syncView({
          lock: { scope: 'all-clubs', lockedBy: 't', lockedAt: null, lockedUntil: null, active: true },
          latestRun: null,
        }),
    });

    expect(view.sync.running).toBe(true);
  });

  it('does not include secrets or connection details in check text', async () => {
    const view = await loadStatusView({
      now: () => new Date('2026-11-18T00:10:00.000Z'),
      runtime,
      supabaseConfigured: false,
      apiKeyConfigured: false,
      loadSync: async () => syncView(),
    });

    const text = JSON.stringify(view);
    expect(text).not.toMatch(/Bearer/i);
    expect(text).not.toMatch(/service_role/i);
    expect(text).not.toMatch(/postgres/i);
    expect(text).not.toMatch(/SUPABASE_/i);
  });
});
