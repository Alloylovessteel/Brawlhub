/** Read-only view models used by the Discord player commands. */

import type { ApiIssue, HistoryPeriod, TrophyProgression } from '../clubs/types';

export type PlayerApiIssue = ApiIssue | 'not-found';

export interface PlayerMegaPig {
  readonly date: string | null;
  readonly wins: number | null;
  readonly draws: number | null;
  readonly losses: number | null;
  readonly ticketsUsed: number | null;
}

export interface PlayerIdentity {
  /** Null when the player was resolved only from a live API response. */
  readonly id: string | null;
  readonly tag: string;
  readonly name: string;
  /** Official profile icon id; used only to resolve a static image URL. */
  readonly iconId: number | null;
  readonly trophies: number | null;
  readonly highestTrophies: number | null;
  readonly expLevel: number | null;
  readonly expPoints: number | null;
  readonly lastSyncedAt: string | null;
  readonly lastBattleAt: string | null;
  readonly fame: number | null;
  readonly fameTierName: string | null;
  readonly totalPrestigeLevel: number | null;
  readonly threeVsThreeVictories: number | null;
  readonly soloVictories: number | null;
  readonly duoVictories: number | null;
  readonly bestRoboRumbleTime: number | null;
  readonly bestTimeAsBigBrawler: number | null;
  readonly rankedRankName: string | null;
  readonly rankedElo: number | null;
  readonly highestSeasonRankedRankName: string | null;
  readonly highestSeasonRankedElo: number | null;
  readonly highestAllTimeRankedRankName: string | null;
  readonly highestAllTimeRankedElo: number | null;
  readonly isQualifiedFromChampionshipChallenge: boolean | null;
  readonly megaPig: PlayerMegaPig | null;
}

export interface PlayerClubRef {
  /** Null when the club came from the live API and is not registered locally. */
  readonly id: string | null;
  readonly tag: string;
  readonly name: string;
  readonly role: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export type ClubMembershipStatus = 'current' | 'last-recorded' | 'past' | 'incomplete';

export interface PlayerBrawler {
  readonly name: string;
  readonly trophies: number;
  readonly highestTrophies: number | null;
  readonly power: number | null;
  readonly rank: number | null;
  readonly prestigeLevel: number | null;
  readonly currentWinStreak: number | null;
  readonly maxWinStreak: number | null;
  readonly gadgets: number;
  readonly starPowers: number;
  readonly gears: number;
  readonly hyperCharges: number;
}

/** One accessory from the official player payload; names are never invented. */
export interface BrawlerAccessoryView {
  readonly id: number | null;
  readonly name: string | null;
  readonly level: number | null;
}

/** Lossless brawler detail used by `/brawlers` and `/brawler`. */
export interface PlayerBrawlerDetail {
  readonly id: number | null;
  readonly name: string;
  readonly trophies: number | null;
  readonly highestTrophies: number | null;
  readonly power: number | null;
  readonly rank: number | null;
  readonly prestigeLevel: number | null;
  readonly currentWinStreak: number | null;
  readonly maxWinStreak: number | null;
  readonly gadgets: readonly BrawlerAccessoryView[];
  readonly starPowers: readonly BrawlerAccessoryView[];
  readonly gears: readonly BrawlerAccessoryView[];
  readonly hyperCharges: readonly BrawlerAccessoryView[];
}

/** Minimal official catalog entry used for names and profile-completeness checks. */
export interface OfficialBrawlerRef {
  readonly id: number;
  readonly name: string;
}

export type BrawlerSort = 'trophies' | 'highest' | 'power' | 'rank' | 'name';
export type BrawlerFilter = 'all' | 'maxed' | 'ranked' | 'unowned';

export interface PlayerBrawlersView {
  readonly player: PlayerIdentity;
  readonly brawlers: readonly PlayerBrawlerDetail[];
  /** Official static catalog; contains names only, not stats, class or rarity. */
  readonly catalog: readonly OfficialBrawlerRef[];
  readonly source: 'live' | 'stored';
  readonly apiIssue: PlayerApiIssue | null;
  readonly fetchedAt: string | null;
}

export interface PlayerProfileStats {
  readonly brawlerCount: number | null;
  readonly totalPrestigeLevels: number | null;
  readonly maxedBrawlers: number | null;
}

export interface PlayerProfileView {
  readonly player: PlayerIdentity;
  readonly currentClub: PlayerClubRef | null;
  readonly brawlers: readonly PlayerBrawler[];
  readonly stats: PlayerProfileStats | null;
  readonly latestSnapshotAt: string | null;
  readonly source: 'live' | 'stored';
  readonly apiIssue: PlayerApiIssue | null;
  readonly profileFetchedAt: string | null;
}

export interface PlayerHistoryPoint {
  readonly capturedAt: string;
  readonly trophies: number | null;
}

export interface PlayerHistoryChange {
  readonly trophies: number | null;
}

export interface PlayerMembershipRecord extends PlayerClubRef {
  readonly id: string;
  readonly status: ClubMembershipStatus;
  readonly durationMs: number | null;
}

export interface PlayerMembershipEvent {
  readonly id: string;
  readonly eventType: 'join' | 'leave' | 'transfer';
  readonly fromClub: PlayerClubRef | null;
  readonly toClub: PlayerClubRef | null;
  readonly detectedAt: string;
}

export interface PlayerHistoryView {
  readonly player: PlayerIdentity;
  readonly period: HistoryPeriod;
  readonly points: readonly PlayerHistoryPoint[];
  readonly currentTrophies: number | null;
  readonly highestRecordedTrophies: number | null;
  readonly firstSnapshotAt: string | null;
  readonly latestSnapshotAt: string | null;
  readonly change: PlayerHistoryChange | null;
  readonly progression: TrophyProgression | null;
  readonly memberships: readonly PlayerMembershipRecord[];
  readonly events: readonly PlayerMembershipEvent[];
}

export interface PlayerBattleRecord {
  readonly id: string;
  readonly syncRunId: string | null;
  readonly battleTime: string;
  readonly mode: string | null;
  readonly map: string | null;
  readonly battleType: string | null;
  readonly result: string | null;
  readonly trophyChange: number | null;
  readonly brawlerName: string | null;
  readonly starPlayerName: string | null;
}

export interface PlayerBattleHistoryView {
  readonly player: PlayerIdentity;
  readonly period: HistoryPeriod;
  readonly battles: readonly PlayerBattleRecord[];
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly trophyChange: number | null;
  readonly topModes: readonly { readonly mode: string; readonly count: number }[];
  readonly firstBattleAt: string | null;
  readonly latestBattleAt: string | null;
}

export interface PlayerClubsView {
  readonly player: PlayerIdentity;
  readonly currentClub: PlayerClubRef | null;
  readonly memberships: readonly PlayerMembershipRecord[];
  readonly events: readonly PlayerMembershipEvent[];
  readonly latestSyncAt: string | null;
  readonly lastBattleAt: string | null;
}

/** Combined read-only data behind the interactive `/me` More section. */
export interface PlayerHighlightsView {
  readonly history: PlayerHistoryView;
  readonly battles: PlayerBattleHistoryView;
  readonly clubs: PlayerClubsView;
}

export interface PlayerComparisonSide {
  readonly player: PlayerIdentity;
  readonly currentClub: PlayerClubRef | null;
  readonly currentTrophies: number | null;
  readonly highestTrophies: number | null;
  readonly expLevel: number | null;
  readonly highestRecordedTrophies: number | null;
  readonly progression: TrophyProgression | null;
  readonly firstSnapshotAt: string | null;
  readonly latestSnapshotAt: string | null;
  readonly snapshotTrophies: number | null;
}

export interface PlayerComparisonView {
  readonly first: PlayerComparisonSide;
  readonly second: PlayerComparisonSide;
  readonly period: HistoryPeriod;
  readonly aligned: boolean;
  readonly warning: string | null;
}

export type PlayerLookupFailure =
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'not-found'; readonly tag: string }
  | { readonly kind: 'api-unavailable'; readonly tag: string; readonly issue: PlayerApiIssue }
  | { readonly kind: 'same-player' };

export type ResolvedPlayerResult<T> =
  | PlayerLookupFailure
  | { readonly kind: 'ok'; readonly value: T };
