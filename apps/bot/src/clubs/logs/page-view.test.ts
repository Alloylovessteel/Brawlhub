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
  isClubLogPeriod,
  loadClubLogView,
  rankClubLogChanges,
} from './page-view';
import type { LeaderboardEntry } from '../types';

function entry(
  tag: string,
  name: string,
  today: number | null,
  week: number | null = today,
  season: number | null = today,
): LeaderboardEntry {
  return {
    tag,
    name,
    trophies: 10_000,
    role: 'member',
    playerId: `player-${tag}`,
    highestTrophies: 12_000,
    rank: 1,
    progression: { today, week, season },
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

  it('ranks stored deltas with stable ties and excludes missing baselines', () => {
    const rows = rankClubLogChanges(
      [entry('B', 'Beta', 50), entry('A', 'Alpha', 100), entry('C', 'Charlie', 100), entry('D', 'Delta', null)],
      'today',
    );

    expect(rows.map((row) => [row.rank, row.member.tag, row.change])).toEqual([
      [1, 'A', 100],
      [1, 'C', 100],
      [3, 'B', 50],
    ]);
    expect(rows[0]?.member).not.toHaveProperty('progression');
  });
});

describe('loadClubLogView', () => {
  it('passes the guild ID and season boundary into the stored leaderboard loader', async () => {
    mocks.loadLeaderboardView.mockResolvedValue({
      kind: 'ok',
      value: {
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
        roster: [],
        rosterSource: 'none',
        latestSyncAt: null,
        entries: [entry('A', 'Alpha', 25)],
      },
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
