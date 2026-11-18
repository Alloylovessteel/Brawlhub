/** Read-only view models used by the Discord player commands. */

import type { ApiIssue, HistoryPeriod, TrophyProgression } from '../clubs/types';

export type PlayerApiIssue = ApiIssue | 'not-found';

export interface PlayerIdentity {
  /** Null when the player was resolved only from a live API response. */
  readonly id: string | null;
  readonly tag: string;
  readonly name: string;
  readonly trophies: number | null;
  readonly highestTrophies: number | null;
  readonly expLevel: number | null;
  readonly lastSyncedAt: string | null;
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
}

export interface PlayerProfileView {
  readonly player: PlayerIdentity;
  readonly currentClub: PlayerClubRef | null;
  readonly brawlers: readonly PlayerBrawler[];
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

export interface PlayerClubsView {
  readonly player: PlayerIdentity;
  readonly currentClub: PlayerClubRef | null;
  readonly memberships: readonly PlayerMembershipRecord[];
  readonly events: readonly PlayerMembershipEvent[];
  readonly latestSyncAt: string | null;
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
