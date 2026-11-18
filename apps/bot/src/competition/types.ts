/** View models and service inputs for the `/competition` competition commands. */

import type { Role } from '@brawlhub/shared';
import type { PlayerIdentity } from '../players/types';

export type CompetitionStatus = 'upcoming' | 'active' | 'completed';

export interface CompetitionClubRef {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
}

export interface CompetitionRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly clubId: string | null;
  readonly club: CompetitionClubRef | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly goal: number | null;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly endedBy: string | null;
  readonly endedAt: string | null;
  readonly entryCount: number;
}

export interface CompetitionActorContext {
  readonly profileId: string;
  readonly discordUserId: string;
  readonly globalRole: Role | null;
  readonly clubRoles: ReadonlyMap<string, Role>;
}

export interface CompetitionVerifiedPlayer {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly verifiedAt: string;
  readonly method: string;
}

export interface CompetitionJoinResult {
  readonly entryId: string;
  readonly baselineTrophies: number | null;
  readonly baselineSource: 'none' | 'player_snapshot' | 'manual_verified';
  readonly baselineCapturedAt: string | null;
}

export interface CompetitionSubmitResult {
  readonly submissionId: string;
  readonly submittedAt: string;
  readonly trophies: number;
  readonly verificationStatus: 'unverified';
}

export type CompetitionSubmissionSource = 'user' | 'api';
export type CompetitionVerificationStatus = 'unverified' | 'verified';

export interface CompetitionSubmission {
  readonly id: string;
  readonly competitionId: string;
  readonly entryId: string;
  readonly trophies: number;
  readonly source: CompetitionSubmissionSource;
  readonly verificationStatus: CompetitionVerificationStatus;
  readonly accepted: boolean;
  readonly submittedByProfileId: string | null;
  readonly submittedAt: string;
  readonly verifiedSnapshotId: string | null;
  readonly verifiedByProfileId: string | null;
}

export interface CompetitionEntry {
  readonly id: string;
  readonly competitionId: string;
  readonly player: PlayerIdentity;
  readonly joinedAt: string;
  readonly baselineTrophies: number | null;
  readonly baselineSource: 'none' | 'player_snapshot' | 'manual_verified';
  readonly baselineCapturedAt: string | null;
}

export interface CompetitionLeaderboardRow {
  /** Null for entries with no accepted submission or no usable baseline. */
  readonly rank: number | null;
  readonly entry: CompetitionEntry;
  readonly trophies: number | null;
  readonly gain: number | null;
  readonly latestSubmissionAt: string | null;
  readonly verificationStatus: CompetitionVerificationStatus | null;
}

export interface CompetitionLeaderboardView {
  readonly competition: CompetitionRecord;
  readonly rows: readonly CompetitionLeaderboardRow[];
  readonly generatedAt: string;
}

export interface CompetitionCreateInput {
  readonly discordUserId: string;
  readonly name: string;
  readonly description: string | null;
  readonly start: string;
  readonly end: string;
  readonly clubId: string | null;
  readonly goal: number | null;
}

export interface CompetitionJoinInput {
  readonly discordUserId: string;
  readonly competitionId: string;
  readonly playerId: string;
}

export interface CompetitionSubmitInput {
  readonly discordUserId: string;
  readonly competitionId: string;
  readonly playerId: string;
  readonly trophies: number;
}

export interface CompetitionEndInput {
  readonly discordUserId: string;
  readonly competitionId: string;
}
