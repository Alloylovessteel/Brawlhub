import { describe, expect, it } from 'vitest';
import type { ClubSnapshot } from '../clubs/types';
import type { PlayerIdentity, PlayerMembershipRecord } from '../players/types';
import {
  averageTrophies,
  calculateProgression,
  chooseClub,
  commonRunId,
  deduplicatePlayers,
  isProgressionPeriod,
  rankByScore,
  timestampsDiffer,
} from './calculate';

const NOW = new Date('2026-11-18T12:00:00.000Z');

function player(tag: string, id = `id-${tag}`): PlayerIdentity {
  return {
    id,
    tag,
    name: `Player ${tag}`,
    iconId: null,
    trophies: null,
    highestTrophies: null,
    expLevel: null,
    expPoints: null,
    lastSyncedAt: null,
    lastBattleAt: null,
    fame: null,
    fameTierName: null,
    totalPrestigeLevel: null,
    threeVsThreeVictories: null,
    soloVictories: null,
    duoVictories: null,
    bestRoboRumbleTime: null,
    bestTimeAsBigBrawler: null,
    rankedRankName: null,
    rankedElo: null,
    highestSeasonRankedRankName: null,
    highestSeasonRankedElo: null,
    highestAllTimeRankedRankName: null,
    highestAllTimeRankedElo: null,
    isQualifiedFromChampionshipChallenge: null,
    megaPig: null,
  };
}

function snapshot(
  id: string,
  capturedAt: string,
  trophies: number | null,
  syncRunId = 'run-1',
): ClubSnapshot {
  return { id, capturedAt, trophies, syncRunId, memberCount: null, raw: null };
}

function membership(
  id: string,
  tag: string,
  status: PlayerMembershipRecord['status'],
  validFrom: string | null,
): PlayerMembershipRecord {
  return {
    id,
    tag,
    name: `Club ${tag}`,
    role: null,
    validFrom,
    validTo: status === 'past' ? '2026-11-01T00:00:00.000Z' : null,
    status,
    durationMs: null,
  };
}

describe('leaderboard calculations', () => {
  it('calculates averages only from valid member counts', () => {
    expect(averageTrophies(9000, 30)).toBe(300);
    expect(averageTrophies(9001, 30)).toBe(300);
    expect(averageTrophies(9000, null)).toBeNull();
    expect(averageTrophies(9000, 0)).toBeNull();
  });

  it('rejects non-supporting progression periods', () => {
    expect(isProgressionPeriod('7d')).toBe(true);
    expect(isProgressionPeriod('30d')).toBe(true);
    expect(isProgressionPeriod('90d')).toBe(true);
    expect(isProgressionPeriod('all')).toBe(false);
    expect(isProgressionPeriod('1d')).toBe(false);
  });

  it('deduplicates players by tag and id', () => {
    const first = player('2C0Y', 'p1');
    const duplicateTag = { ...player('2c0y', 'p2') };
    const duplicateId = { ...player('Q8VR', 'p1') };
    const distinct = player('Q8VR', 'p3');

    expect(deduplicatePlayers([first, duplicateTag, duplicateId, distinct])).toEqual([
      first,
      distinct,
    ]);
  });

  it('sorts by score and gives tied rows the same position', () => {
    const rows = [
      { name: 'Bravo', trophies: 5000 },
      { name: 'Alpha', trophies: 5000 },
      { name: 'Charlie', trophies: 4000 },
      { name: 'Delta', trophies: null },
    ];
    const ranked = rankByScore(
      rows,
      (row) => row.trophies,
      (a, b) => a.name.localeCompare(b.name),
    );

    expect(ranked.map((entry) => [entry.item.name, entry.rank])).toEqual([
      ['Alpha', 1],
      ['Bravo', 1],
      ['Charlie', 3],
    ]);
  });

  it('prefers current membership records over historical ones', () => {
    const memberships = [
      membership('old-current', '8QCL', 'past', '2026-11-10T00:00:00.000Z'),
      membership('stale-open', 'Q8VR', 'last-recorded', '2026-11-05T00:00:00.000Z'),
      membership('current', '2C0Y', 'current', '2026-11-01T00:00:00.000Z'),
    ];

    expect(chooseClub(memberships)?.club.tag).toBe('2C0Y');
    expect(chooseClub(memberships)?.status).toBe('current');
    expect(chooseClub(memberships.slice(0, 2))?.club.tag).toBe('Q8VR');
    expect(chooseClub([])).toBeNull();
  });

  it('finds the latest completed run shared by every snapshot group', () => {
    const groups = [
      [
        snapshot('a1', '2026-11-01T00:00:00.000Z', 100, 'run-1'),
        snapshot('a2', '2026-11-17T00:00:00.000Z', 200, 'run-3'),
      ],
      [
        snapshot('b1', '2026-11-01T00:00:00.000Z', 100, 'run-1'),
        snapshot('b2', '2026-11-17T00:00:00.000Z', 150, 'run-3'),
      ],
    ];
    expect(commonRunId(groups)).toBe('run-3');
    expect(commonRunId([groups[0]!, []])).toBeNull();
    expect(commonRunId([])).toBeNull();
  });

  it('calculates progression only from real snapshots inside each period', () => {
    const snapshots = [
      snapshot('s1', '2026-10-01T00:00:00.000Z', 1000, 'run-1'),
      snapshot('s2', '2026-11-05T00:00:00.000Z', 1100, 'run-2'),
      snapshot('s3', '2026-11-15T00:00:00.000Z', 1250, 'run-3'),
      snapshot('s4', '2026-11-17T00:00:00.000Z', 1300, 'run-4'),
      snapshot('missing', '2026-11-16T00:00:00.000Z', null, 'run-5'),
    ];

    expect(calculateProgression(snapshots, '7d', NOW)).toMatchObject({
      start: { id: 's3' },
      latest: { id: 's4' },
      difference: 50,
    });
    expect(calculateProgression(snapshots, '30d', NOW)).toMatchObject({
      start: { id: 's2' },
      latest: { id: 's4' },
      difference: 200,
    });
    expect(calculateProgression(snapshots, '90d', NOW)).toMatchObject({
      start: { id: 's1' },
      latest: { id: 's4' },
      difference: 300,
    });
  });

  it('excludes insufficient history and honours a shared run without interpolating', () => {
    const snapshots = [
      snapshot('s1', '2026-11-05T00:00:00.000Z', 1000, 'run-1'),
      snapshot('s2', '2026-11-10T00:00:00.000Z', 1100, 'shared'),
      snapshot('s3', '2026-11-17T00:00:00.000Z', 1200, 'other'),
    ];

    expect(calculateProgression([snapshots[0]!], '30d', NOW)).toBeNull();
    expect(
      calculateProgression([snapshots[0]!, { ...snapshots[0]!, id: 'duplicate' }], '30d', NOW),
    ).toBeNull();
    expect(calculateProgression(snapshots, '30d', NOW, 'shared')).toMatchObject({
      latest: { id: 's2' },
      difference: 100,
      alignedWithRun: true,
    });
    expect(calculateProgression(snapshots, '30d', NOW, 'absent')).toMatchObject({
      latest: { id: 's3' },
      alignedWithRun: false,
    });
  });

  it('detects different snapshot timestamps', () => {
    expect(
      timestampsDiffer(['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']),
    ).toBe(false);
    expect(
      timestampsDiffer(['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z']),
    ).toBe(true);
  });
});
