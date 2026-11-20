import { describe, expect, it } from 'vitest';
import { buildSyncStatusEmbed } from './embed';
import type { SyncStatusView } from './types';

const lock = {
  scope: 'guild:1488531664962326571',
  lockedBy: 'token',
  lockedAt: '2026-11-20T06:06:09.000Z',
  lockedUntil: '2026-11-20T06:36:09.000Z',
  active: true,
};

const run = {
  id: 'run-1',
  status: 'running',
  periodStart: null,
  startedAt: '2026-11-20T06:06:08.000Z',
  finishedAt: null,
  error: null,
  lastError: 'Sync interrupted by process restart',
  recordsProcessed: 0,
  affectedClubIds: ['club-1'],
  clubTags: ['2UG9UGQJY'],
};

describe('buildSyncStatusEmbed', () => {
  it('labels a retained last_error as previous on an in-progress run', () => {
    const json = buildSyncStatusEmbed({
      latestRun: run,
      lock,
      generatedAt: new Date('2026-11-20T06:07:00.000Z'),
    } satisfies SyncStatusView).toJSON();
    const fields = json.fields ?? [];

    expect(fields.find((field) => field.name === 'Error')).toBeUndefined();
    expect(fields.find((field) => field.name === 'Previous error')?.value).toBe(
      'Sync interrupted by process restart',
    );
  });

  it('shows the active error on a failed run', () => {
    const json = buildSyncStatusEmbed({
      latestRun: {
        ...run,
        status: 'failed',
        error: 'Official API rejected the request',
      },
      lock: { ...lock, active: false },
      generatedAt: new Date('2026-11-20T06:07:00.000Z'),
    } satisfies SyncStatusView).toJSON();
    const fields = json.fields ?? [];

    expect(fields.find((field) => field.name === 'Error')?.value).toBe(
      'Official API rejected the request',
    );
  });
});
