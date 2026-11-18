import { describe, expect, it } from 'vitest';
import {
  calculateAverage,
  calculateTrophyProgression,
  calculateTrophyRange,
  countRole,
} from './calculate';
import type { ClubSnapshot, RosterMember } from './types';

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
});
