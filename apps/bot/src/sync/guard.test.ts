import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@brawlhub/sync';
import { clearStateCachesForTests, readRuntimeLease } from '../state/index.js';
import { resetManagedSyncGuard, runManagedSync } from './guard';

function result(status: SyncResult['status'] = 'completed'): SyncResult {
  return {
    syncRunId: 'run-1',
    status,
    clubsProcessed: 1,
    playersUpserted: 2,
    snapshotsWritten: 3,
    membershipEvents: 4,
    notificationsSent: 0,
    battlesCollected: 0,
    error: undefined,
    affectedClubIds: ['club-1'],
  };
}

describe('runManagedSync', () => {
  beforeEach(() => {
    resetManagedSyncGuard();
    clearStateCachesForTests();
  });

  it('runs the provided pipeline once', async () => {
    const run = vi.fn(async () => [result()]);

    const outcome = await runManagedSync({ run });

    expect(outcome).toEqual({ kind: 'ran', results: [result()] });
    expect(run).toHaveBeenCalledOnce();
  });

  it('releases the DB runtime lease after a run', async () => {
    await runManagedSync({ run: vi.fn(async () => [result()]) });

    const lease = await readRuntimeLease({ leaseKind: 'managed-sync', scope: 'all-guilds' });
    expect(lease).not.toBeNull();
    expect(lease?.releasedAt).not.toBeNull();
  });

  it('refuses an overlapping in-process run', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await pending;
      return [result()];
    });

    const first = runManagedSync({ run });
    const second = await runManagedSync({ run });
    release?.();
    await first;

    expect(second).toEqual({ kind: 'overlap' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('releases the guard when the pipeline rejects', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(runManagedSync({ run })).rejects.toThrow('boom');
    await expect(runManagedSync({ run: vi.fn(async () => [result()]) })).resolves.toEqual({
      kind: 'ran',
      results: [result()],
    });
  });
});
