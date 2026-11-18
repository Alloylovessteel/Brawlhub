/** Read-only view models for the global leaderboard commands. */

import type { ClubRecord } from '../clubs/types';
import type { ClubMembershipStatus, PlayerClubRef, PlayerIdentity } from '../players/types';

export type ProgressionPeriod = '7d' | '30d' | '90d';

export interface ClubChoice {
  readonly club: PlayerClubRef;
  readonly status: ClubMembershipStatus;
}

export interface RankedRow {
  readonly rank: number;
}

export interface ClubLeaderboardRow extends RankedRow {
  readonly club: ClubRecord;
  readonly totalTrophies: number;
  readonly memberCount: number | null;
  readonly averageTrophies: number | null;
  readonly snapshotAt: string;
  readonly syncRunId: string;
}

export interface PlayerLeaderboardRow extends RankedRow {
  readonly player: PlayerIdentity;
  readonly trophies: number;
  readonly club: PlayerClubRef | null;
  readonly clubStatus: ClubMembershipStatus | null;
}

export interface TrophyLeaderboardRow extends RankedRow {
  readonly player: PlayerIdentity;
  readonly highestTrophies: number;
  readonly currentTrophies: number | null;
  readonly club: PlayerClubRef | null;
  readonly clubStatus: ClubMembershipStatus | null;
}

export interface ProgressionLeaderboardRow extends RankedRow {
  readonly player: PlayerIdentity;
  readonly startTrophies: number;
  readonly latestTrophies: number;
  readonly difference: number;
  readonly startAt: string;
  readonly latestAt: string;
  readonly syncRunId: string;
  readonly club: PlayerClubRef | null;
  readonly clubStatus: ClubMembershipStatus | null;
}

interface LeaderboardMeta {
  readonly rows: readonly RankedRow[];
  readonly generatedAt: string;
  readonly latestSyncAt: string | null;
  readonly warning: string | null;
}

export interface ClubLeaderboardView extends LeaderboardMeta {
  readonly rows: readonly ClubLeaderboardRow[];
}

export interface PlayerLeaderboardView extends LeaderboardMeta {
  readonly rows: readonly PlayerLeaderboardRow[];
}

export interface TrophyLeaderboardView extends LeaderboardMeta {
  readonly rows: readonly TrophyLeaderboardRow[];
}

export interface ProgressionLeaderboardView extends LeaderboardMeta {
  readonly period: ProgressionPeriod;
  readonly rows: readonly ProgressionLeaderboardRow[];
}
