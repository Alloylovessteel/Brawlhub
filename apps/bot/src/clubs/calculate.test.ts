import { describe, expect, it } from 'vitest';
import {
  calculateAverage,
  calculateHistoryChange,
  calculateTrophyProgression,
  calculateTrophyRange,
  countRole,
  filterSnapshotsByPeriod,
  rankByTrophies,
  sortMembersByTrophies,
} from './calculate';
import type { ClubSnapshot, HistoryPoint, MemberDetail, RosterMember } from './types';

function snapshot(capturedAt: string, trophies: number): ClubSnapshot {
  return {
    id: capturedAt,
    syncRunId: `run-${capturedAt}`,
    capturedAt,
    trophies,
    memberCount: 30,
    raw: null,
  };
}

function member(role: string | null, trophies: number | null): RosterMember {
  return { tag: 'G2P9', name: 'Player', trophies, role };
}

function detail(tag: string, name: string, trophies: number | null): MemberDetail {
  return { tag, name, trophies, role: null, playerId: null, highestTrophies: null };
}

function point(capturedAt: string, values: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    capturedAt,
    syncRunId: `run-${capturedAt}`,
    trophies: null,
    averageTrophies: null,
    memberCount: null,
    ...values,
  };
}

describe('club calculations', () => {
  it('averages only valid trophy values and rounds to an integer', () => {
    expect(calculateAverage([1, 2, null, undefined, 4])).toBe(2);
    expect(calculateAverage([1, 2, 2])).toBe(2);
    expect(calculateAverage([null])).toBeNull();
  });

  it('finds the trophy range from incomplete rosters', () => {
    expect(calculateTrophyRange([member(null, 100), member(null, null), member(null, 90)])).toEqual({
      low: 90,
      high: 100,
    });
    expect(calculateTrophyRange([member(null, null)])).toBeNull();
  });

  it('calculates progression from snapshots at each window boundary', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const snapshots = [
      snapshot('2026-11-01T23:59:00.000Z', 1000),
      snapshot('2026-11-16T00:00:00.000Z', 1100),
      snapshot('2026-11-18T00:00:00.000Z', 1200),
    ];

    expect(
      calculateTrophyProgression({
        snapshots,
        currentTrophies: 1300,
        currentAt: now.toISOString(),
        now,
        seasonStartIso: '2026-11-02T00:00:00Z',
      }),
    ).toEqual({ today: 100, week: 200, season: 300 });
  });

  it('omits progression values without the required history or season boundary', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const snapshots = [snapshot('2026-11-18T06:00:00.000Z', 1200)];

    expect(
      calculateTrophyProgression({
        snapshots,
        currentTrophies: 1300,
        currentAt: now.toISOString(),
        now,
      }),
    ).toEqual({ today: null, week: null, season: null });
  });

  it('omits season progression when no season boundary is configured', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const snapshots = [snapshot('2026-11-01T00:00:00.000Z', 1000)];

    expect(
      calculateTrophyProgression({
        snapshots,
        currentTrophies: 1300,
        currentAt: now.toISOString(),
        now,
        seasonStartIso: 'not-a-date',
      }).season,
    ).toBeNull();
  });

  it('counts roles only when role data is present', () => {
    expect(countRole([member(null, 1), member(null, 2)], 'senior')).toBeNull();
    expect(
      countRole(
        [member('senior', 1), member('senior', 2), member('vicePresident', 3)],
        'senior',
      ),
    ).toBe(2);
  });

  it('sorts rosters by trophies and keeps incomplete rows last', () => {
    const roster = [
      detail('LOW', 'Low', 100),
      detail('NONE', 'Unknown', null),
      detail('HIGH', 'High', 900),
      detail('MID', 'Mid', 500),
    ];

    expect(sortMembersByTrophies(roster).map((entry) => entry.tag)).toEqual([
      'HIGH',
      'MID',
      'LOW',
      'NONE',
    ]);
    expect(roster[0]?.tag).toBe('LOW');
  });

  it('ranks valid trophy values and shares ranks for ties', () => {
    const ranked = rankByTrophies([
      detail('LOW', 'Low', 800),
      detail('TIED_B', 'Bravo', 1000),
      detail('NONE', 'No Trophies', null),
      detail('TIED_A', 'Alpha', 1000),
    ]);

    expect(ranked.map((entry) => [entry.rank, entry.tag])).toEqual([
      [1, 'TIED_A'],
      [1, 'TIED_B'],
      [3, 'LOW'],
    ]);
    expect(ranked.every((entry) => entry.progression === null)).toBe(true);
  });

  it('filters stored snapshots by period without creating new points', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const snapshots = [
      snapshot('2026-11-10T11:59:00.000Z', 900),
      snapshot('2026-11-17T00:00:00.000Z', 1100),
      snapshot('2026-11-18T06:00:00.000Z', 1200),
      { ...snapshot('not-a-date', 999), capturedAt: 'not-a-date' },
    ];

    expect(filterSnapshotsByPeriod(snapshots, '7d', now).map((item) => item.trophies)).toEqual([
      1100, 1200,
    ]);
    expect(filterSnapshotsByPeriod(snapshots, 'all', now).map((item) => item.trophies)).toEqual([
      900, 1100, 1200,
    ]);
  });

  it('calculates history changes only between real stored endpoints', () => {
    const points = [
      point('2026-11-01T00:00:00.000Z', { trophies: 1000, averageTrophies: 700, memberCount: 12 }),
      point('2026-11-18T00:00:00.000Z', { trophies: 1200, averageTrophies: 800, memberCount: 10 }),
    ];

    expect(calculateHistoryChange(points)).toEqual({
      trophies: 200,
      averageTrophies: 100,
      memberCount: -2,
    });
    expect(calculateHistoryChange(points.slice(0, 1))).toBeNull();
    expect(
      calculateHistoryChange([
        point('2026-11-01T00:00:00.000Z', { trophies: 1000 }),
        point('2026-11-18T00:00:00.000Z', { trophies: null }),
      ]),
    ).toEqual({ trophies: null, averageTrophies: null, memberCount: null });
  });
});
