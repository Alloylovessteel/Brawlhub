import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import type { PlayerIdentity } from '../players/types';
import {
  buildCompetitionCreatedEmbed,
  buildCompetitionLeaderboardEmbed,
  buildCompetitionListEmbed,
  buildCompetitionSubmittedEmbed,
  formatCompetitionTimestamp,
} from './embed';
import type {
  CompetitionRecord,
  CompetitionLeaderboardRow,
  CompetitionLeaderboardView,
  CompetitionSubmitResult,
} from './types';

const CONFIG = { playerProfileUrlTemplate: 'https://example.test/player/{tag}' };
const NOW = new Date('2026-11-21T12:00:00.000Z');

function competition(overrides: Partial<CompetitionRecord> = {}): CompetitionRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Midseason Climb',
    description: 'No camping and no account sharing.',
    clubId: null,
    club: null,
    startsAt: '2026-11-20T00:00:00.000Z',
    endsAt: '2026-11-22T00:00:00.000Z',
    goal: 12_500,
    status: 'scheduled',
    createdBy: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    endedBy: null,
    endedAt: null,
    entryCount: 2,
    ...overrides,
  };
}

function player(name: string): PlayerIdentity {
  return {
    id: 'player-1',
    tag: '2C0Y',
    name,
    iconId: null,
    trophies: 5_000,
    highestTrophies: 5_200,
    expLevel: 40,
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

function row(
  rank: number | null,
  name: string,
  trophies: number | null,
  gain: number | null,
): CompetitionLeaderboardRow {
  return {
    rank,
    entry: {
      id: `entry-${name}`,
      competitionId: competition().id,
      player: player(name),
      joinedAt: '2026-11-18T00:00:00.000Z',
      baselineTrophies: gain === null ? null : 4_000,
      baselineSource: gain === null ? 'none' : 'player_snapshot',
      baselineCapturedAt: null,
    },
    trophies,
    gain,
    latestSubmissionAt: '2026-11-21T10:00:00.000Z',
    verificationStatus: trophies === null ? null : 'unverified',
  };
}

function view(rows: CompetitionLeaderboardRow[]): CompetitionLeaderboardView {
  return { competition: competition(), rows, generatedAt: NOW.toISOString() };
}

function text(embed: ReturnType<typeof buildCompetitionCreatedEmbed>): string {
  const json = embed.toJSON();
  return [
    json.title ?? '',
    json.description ?? '',
    json.footer?.text ?? '',
    ...(json.fields ?? []).map((field) => `${field.name} ${field.value}`),
  ].join('\n');
}

describe('competition embeds', () => {
  it('renders Discord timestamps and gracefully handles missing values', () => {
    expect(formatCompetitionTimestamp('2026-11-20T00:00:00.000Z', 'F')).toBe('<t:1795132800:F>');
    expect(formatCompetitionTimestamp(null, 'R')).toBe('—');
  });

  it('shows rules, period, goal and thousands separators on creation', () => {
    const embed = buildCompetitionCreatedEmbed(competition(), NOW);
    const body = text(embed);
    expect(body).toContain('No camping and no account sharing.');
    expect(body).toContain('12,500 trophies');
    expect(body).toContain('<t:');
    expect(body).toContain('opens at its configured start time');
  });

  it('clearly labels unverified submissions', () => {
    const result: CompetitionSubmitResult = {
      submissionId: 'submission-1',
      submittedAt: '2026-11-21T10:00:00.000Z',
      trophies: 12_345,
      verificationStatus: 'unverified',
    };
    const body = text(buildCompetitionSubmittedEmbed(competition(), player('Alpha'), result, CONFIG, NOW));
    expect(body).toContain('12,345');
    expect(body).toContain('Unverified user submission');
    expect(body).not.toContain('verified API data');
  });

  it('shows shared ranks, negative gains and missing baselines', () => {
    const leaderboard = view([
      row(1, 'Alpha', 5_000, 1_000),
      row(1, 'Bravo', 5_000, 1_000),
      row(3, 'Charlie', 3_500, -500),
      row(null, 'Delta', 9_000, null),
    ]);
    const page = paginate(leaderboard.rows, 1, 10);
    const body = text(buildCompetitionLeaderboardEmbed(leaderboard, page, CONFIG, NOW));

    expect(body).toContain('#1 [Alpha]');
    expect(body).toContain('#1 [Bravo]');
    expect(body).toContain('-500');
    expect(body).toContain('baseline unavailable');
    expect(body).toContain('unverified user submission');
  });

  it('handles empty leaderboards and empty competition lists', () => {
    const leaderboard = view([]);
    const leaderboardBody = text(
      buildCompetitionLeaderboardEmbed(leaderboard, paginate(leaderboard.rows, 1, 10), CONFIG, NOW),
    );
    expect(leaderboardBody).toContain('No one has joined this competition yet.');

    const emptyPage = paginate([], 1, 5);
    expect(emptyPage.items).toEqual([]);
    const listBody = text(buildCompetitionListEmbed([], emptyPage, NOW));
    expect(listBody).toContain('No competitions have been created yet.');
  });
});
