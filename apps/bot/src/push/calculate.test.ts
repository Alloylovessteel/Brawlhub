import { describe, expect, it } from 'vitest';
import {
  calculateGain,
  competitionStatus,
  latestAcceptedSubmissions,
  rankPushRows,
} from './calculate';
import type {
  PushCompetitionRecord,
  PushEntry,
  PushLeaderboardRow,
  PushSubmission,
} from './types';

function competition(overrides: Partial<PushCompetitionRecord> = {}): PushCompetitionRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Push',
    description: null,
    clubId: null,
    club: null,
    startsAt: '2026-11-20T00:00:00.000Z',
    endsAt: '2026-11-22T00:00:00.000Z',
    goal: null,
    status: 'scheduled',
    createdBy: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    endedBy: null,
    endedAt: null,
    entryCount: 0,
    ...overrides,
  };
}

function entry(id: string, name: string, baseline: number | null): PushEntry {
  return {
    id,
    competitionId: competition().id,
    player: {
      id: id.replace('e', 'p'),
      tag: '2C0Y',
      name,
      trophies: null,
      highestTrophies: null,
      expLevel: null,
      lastSyncedAt: null,
    },
    joinedAt: '2026-11-18T01:00:00.000Z',
    baselineTrophies: baseline,
    baselineSource: baseline === null ? 'none' : 'player_snapshot',
    baselineCapturedAt: baseline === null ? null : '2026-11-19T23:00:00.000Z',
  };
}

function submission(
  id: string,
  entryId: string,
  trophies: number,
  submittedAt: string,
  accepted = true,
): PushSubmission {
  return {
    id,
    competitionId: competition().id,
    entryId,
    trophies,
    source: 'user',
    verificationStatus: 'unverified',
    accepted,
    submittedByProfileId: 'profile-1',
    submittedAt,
    verifiedSnapshotId: null,
    verifiedByProfileId: null,
  };
}

function unranked(
  entryValue: PushEntry,
  trophies: number | null,
  gain: number | null,
): Omit<PushLeaderboardRow, 'rank'> {
  return {
    entry: entryValue,
    trophies,
    gain,
    latestSubmissionAt: null,
    verificationStatus: trophies === null ? null : 'unverified',
  };
}

describe('push lifecycle helpers', () => {
  it('derives upcoming, active and completed statuses without starting early', () => {
    expect(competitionStatus(competition(), new Date('2026-11-19T23:59:59.000Z'))).toBe('upcoming');
    expect(competitionStatus(competition(), new Date('2026-11-20T00:00:00.000Z'))).toBe('active');
    expect(competitionStatus(competition(), new Date('2026-11-22T00:00:01.000Z'))).toBe('completed');
    expect(
      competitionStatus(
        competition({ status: 'scheduled', endedAt: '2026-11-21T00:00:00.000Z' }),
        new Date('2026-11-21T00:00:01.000Z'),
      ),
    ).toBe('completed');
  });

  it('never treats a missing baseline as zero', () => {
    expect(calculateGain(5_000, 4_000)).toBe(1_000);
    expect(calculateGain(5_000, null)).toBeNull();
    expect(calculateGain(4_000, 5_000)).toBe(-1_000);
  });

  it('keeps the latest accepted submission and ignores rejected rows', () => {
    const latest = latestAcceptedSubmissions([
      submission('a', 'e1', 4_000, '2026-11-20T10:00:00.000Z'),
      submission('b', 'e1', 4_500, '2026-11-20T11:00:00.000Z'),
      submission('c', 'e1', 9_999, '2026-11-20T12:00:00.000Z', false),
      submission('d', 'e2', 3_000, '2026-11-20T09:00:00.000Z'),
    ]);

    expect(latest.get('e1')?.id).toBe('b');
    expect(latest.get('e2')?.id).toBe('d');
  });

  it('shares positions for equal gains and separates negative gains from missing baselines', () => {
    const ranked = rankPushRows([
      unranked(entry('e1', 'Alpha', 4_000), 5_000, 1_000),
      unranked(entry('e2', 'Bravo', 3_000), 4_000, 1_000),
      unranked(entry('e3', 'Charlie', 5_000), 4_500, -500),
      unranked(entry('e4', 'Delta', null), 9_000, null),
    ]);

    expect(ranked.map((row) => [row.entry.player.name, row.rank])).toEqual([
      ['Alpha', 1],
      ['Bravo', 1],
      ['Charlie', 3],
      ['Delta', null],
    ]);
  });
});
