import { describe, expect, it } from 'vitest';
import type { ClubSnapshot } from '../clubs/types';
import {
  calculatePlayerHistoryChange,
  classifyMembershipStatus,
  filterPlayerSnapshots,
  highestRecordedTrophies,
  isRecentSync,
  membershipDurationMs,
  sharedCompletedRunId,
  snapshotWindowsDiffer,
  toHistoryPoints,
} from './calculate';

function snapshot(id: string, capturedAt: string, trophies: number | null, syncRunId = 'run-1'): ClubSnapshot {
  return { id, capturedAt, trophies, syncRunId, memberCount: null, raw: null };
}

describe('player calculations', () => {
  const now = new Date('2026-11-18T12:00:00.000Z');

  const snapshots = [
    snapshot('s1', '2026-10-01T00:00:00.000Z', 1000, 'old'),
    snapshot('s2', '2026-11-10T00:00:00.000Z', 1200, 'run-1'),
    snapshot('s3', '2026-11-15T00:00:00.000Z', null, 'run-2'),
    snapshot('s4', '2026-11-17T00:00:00.000Z', 1400, 'run-3'),
  ];

  it('filters stored snapshots by period without creating new points', () => {
    expect(filterPlayerSnapshots(snapshots, '7d', now).map((point) => point.id)).toEqual(['s3', 's4']);
    expect(filterPlayerSnapshots(snapshots, '30d', now).map((point) => point.id)).toEqual([
      's2',
      's3',
      's4',
    ]);
    expect(filterPlayerSnapshots(snapshots, 'all', now)).toHaveLength(4);
  });

  it('preserves missing trophy values instead of inferring them', () => {
    expect(toHistoryPoints([snapshots[2]!])).toEqual([
      { capturedAt: '2026-11-15T00:00:00.000Z', trophies: null },
    ]);
  });

  it('calculates change only from real stored endpoints', () => {
    const points = toHistoryPoints(filterPlayerSnapshots(snapshots, '30d', now));
    expect(calculatePlayerHistoryChange(points)).toEqual({ trophies: 200 });
    expect(calculatePlayerHistoryChange(points.slice(0, 1))).toBeNull();
    expect(calculatePlayerHistoryChange(toHistoryPoints([snapshots[2]!, snapshots[2]!]))).toBeNull();
  });

  it('uses only recorded values for the highest trophy figure', () => {
    const points = toHistoryPoints(filterPlayerSnapshots(snapshots, '30d', now));
    expect(highestRecordedTrophies(points, null)).toBe(1400);
    expect(highestRecordedTrophies(points, 1600)).toBe(1600);
    expect(highestRecordedTrophies([], null)).toBeNull();
  });

  it('computes duration only when both membership dates exist', () => {
    expect(
      membershipDurationMs('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    ).toBe(31 * 24 * 60 * 60 * 1000);
    expect(membershipDurationMs('2026-10-01T00:00:00.000Z', null)).toBeNull();
    expect(membershipDurationMs(null, '2026-11-01T00:00:00.000Z')).toBeNull();
    expect(
      membershipDurationMs('2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    ).toBeNull();
  });

  it('downgrades stale open memberships instead of calling them current', () => {
    expect(isRecentSync('2026-11-18T11:50:00.000Z', now, 15 * 60_000)).toBe(true);
    expect(isRecentSync('2026-11-18T10:00:00.000Z', now, 15 * 60_000)).toBe(false);
    expect(isRecentSync(null, now, 15 * 60_000)).toBe(false);

    expect(
      classifyMembershipStatus('2026-11-01T00:00:00.000Z', null, '2026-11-18T11:50:00.000Z', now, 15 * 60_000),
    ).toBe('current');
    expect(
      classifyMembershipStatus('2026-11-01T00:00:00.000Z', null, '2026-11-17T11:50:00.000Z', now, 15 * 60_000),
    ).toBe('last-recorded');
    expect(
      classifyMembershipStatus('2026-11-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z', null, now, 15 * 60_000),
    ).toBe('past');
    expect(classifyMembershipStatus(null, null, null, now, 15 * 60_000)).toBe('incomplete');
  });

  it('finds the latest shared completed run and detects different windows', () => {
    const first = [snapshot('a1', '2026-11-16T00:00:00.000Z', 100, 'shared-old')];
    const second = [
      snapshot('b1', '2026-11-17T00:00:00.000Z', 200, 'shared-old'),
      snapshot('b2', '2026-11-18T00:00:00.000Z', 300, 'only-second'),
    ];
    expect(
      sharedCompletedRunId(
        first,
        second,
        new Set(['shared-old']),
        new Set(['shared-old', 'only-second']),
      ),
    ).toBe('shared-old');
    expect(sharedCompletedRunId(first, second, new Set(), new Set(['shared-old']))).toBeNull();

    expect(snapshotWindowsDiffer('2026-11-01T00:00:00.000Z', '2026-11-18T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-18T00:00:00.000Z')).toBe(false);
    expect(snapshotWindowsDiffer('2026-11-02T00:00:00.000Z', '2026-11-18T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-18T00:00:00.000Z')).toBe(true);
  });
});
