import { beforeEach, describe, expect, it, vi } from 'vitest';

const GUILD_ID = '123456789012345678';

const mocks = vi.hoisted(() => ({
  getBotConfig: vi.fn(),
  loadLeaderboardView: vi.fn(),
}));

vi.mock('../../config', () => ({ getBotConfig: mocks.getBotConfig }));
vi.mock('../service', () => ({ loadLeaderboardView: mocks.loadLeaderboardView }));

import {
  CLUB_LOG_PERIOD_LABELS,
  CLUB_LOG_PERIODS,
  isClubLogPeriod,
  loadClubLogView,
  rankClubLogChanges,
  toClubLogView,
} from './page-view';
import type {
  ClubLogPeriod,
  LeaderboardEntry,
  LeaderboardView,
  MemberDetail,
} from '../types';

function detail(tag: string, name: string): MemberDetail {
  return {
    tag,
    name,
    trophies: 10_000,
    role: 'member',
    playerId: `player-${tag}`,
    highestTrophies: 12_000,
  };
}

function entry(
  tag: string,
  name: string,
  today: number | null,
  week: number | null = today,
  season: number | null = today,
): LeaderboardEntry {
  return {
    ...detail(tag, name),
    rank: 1,
    progression: { today, week, season },
  };
}

function leaderboardValue(
  members: readonly MemberDetail[],
  entries: readonly LeaderboardEntry[],
): LeaderboardView {
  return {
    club: {
      id: 'club-1',
      tag: 'ALPHA',
      name: 'Alpha',
      description: null,
      trophies: null,
      requiredTrophies: null,
      memberCount: null,
      lastSyncedAt: null,
    },
    snapshots: [],
    completedRunIds: new Set<string>(),
    latestSnapshot: null,
    roster: members,
    rosterSource: 'memberships',
    latestSyncAt: null,
    members,
    entries,
  };
}

beforeEach(() => {
  mocks.getBotConfig.mockReset();
  mocks.getBotConfig.mockReturnValue({ seasonStartIso: '2026-01-01T00:00:00.000Z' });
  mocks.loadLeaderboardView.mockReset();
});

describe('club log period helpers', () => {
  it('accepts only the three stored progression periods', () => {
    expect(isClubLogPeriod('today')).toBe(true);
    expect(isClubLogPeriod('week')).toBe(true);
    expect(isClubLogPeriod('season')).toBe(true);
    expect(isClubLogPeriod('month')).toBe(false);
    expect(CLUB_LOG_PERIOD_LABELS).toEqual({
      today: 'Today',
      week: 'This Week',
      season: 'This Season',
    });
  });

  it('ranks stored deltas with stable ties and shows missing baselines as 0', () => {
    const rows = rankClubLogChanges(
      [entry('B', 'Beta', 50), entry('A', 'Alpha', 100), entry('C', 'Charlie', 100), entry('D', 'Delta', null)],
      'today',
    );

    expect(rows.map((row) => [row.rank, row.member.tag, row.change])).toEqual([
      [1, 'A', 100],
      [1, 'C', 100],
      [3, 'B', 50],
      [4, 'D', 0],
    ]);
    expect(rows[0]?.member).not.toHaveProperty('progression');
  });

  it('includes every roster member for today, week and season', () => {
    const members = [
      detail('A', 'Alpha'),
      detail('B', 'Beta'),
      detail('C', 'Charlie'),
      detail('D', 'Delta'),
    ];
    const entries = [
      entry('A', 'Alpha', 0, 10, 20),
      entry('B', 'Beta', null, 0, null),
      entry('C', 'Charlie', -5),
    ];
    const expected: Record<
      ClubLogPeriod,
      { tags: readonly string[]; changes: readonly number[]; unavailable: number }
    > = {
      today: { tags: ['A', 'B', 'D', 'C'], changes: [0, 0, 0, -5], unavailable: 2 },
      week: { tags: ['A', 'B', 'D', 'C'], changes: [10, 0, 0, -5], unavailable: 1 },
      season: { tags: ['A', 'B', 'D', 'C'], changes: [20, 0, 0, -5], unavailable: 2 },
    };

    for (const period of CLUB_LOG_PERIODS) {
      const view = toClubLogView(
        { kind: 'ok', value: leaderboardValue(members, entries) },
        period,
      );

      expect(view.rows).toHaveLength(members.length);
      expect(view.rows.map((row) => row.member.tag)).toEqual([...expected[period].tags]);
      expect(view.rows.map((row) => row.change)).toEqual([...expected[period].changes]);
      expect(view.unavailable).toBe(expected[period].unavailable);
    }
  });
});

describe('loadClubLogView', () => {
  it('passes the guild ID and season boundary into the stored leaderboard loader', async () => {
    const loaded = entry('A', 'Alpha', 25);
    mocks.loadLeaderboardView.mockResolvedValue({
      kind: 'ok',
      value: leaderboardValue([loaded], [loaded]),
    });

    const result = await loadClubLogView({ guildId: GUILD_ID, tag: 'ALPHA', period: 'today' });

    expect(mocks.loadLeaderboardView).toHaveBeenCalledWith({
      tag: 'ALPHA',
      guildId: GUILD_ID,
      seasonStartIso: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toMatchObject({
      kind: 'ok',
      value: { period: 'today', unavailable: 0, rows: [{ rank: 1, change: 25 }] },
    });
  });

  it('returns lookup failures unchanged without leaking another guild', async () => {
    mocks.loadLeaderboardView.mockResolvedValue({ kind: 'no-default' });

    const result = await loadClubLogView({ guildId: GUILD_ID, period: 'week' });

    expect(result).toEqual({ kind: 'no-default' });
  });
});
