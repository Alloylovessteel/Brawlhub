/** View models and service inputs for the `/push` competition commands. */

import type { Role } from '@brawlhub/shared';
import type { PlayerIdentity } from '../players/types';

export type PushCompetitionStatus = 'upcoming' | 'active' | 'completed';

export interface PushClubRef {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
}

export interface PushCompetitionRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly clubId: string | null;
  readonly club: PushClubRef | null;
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

export interface PushActorContext {
  readonly profileId: string;
  readonly discordUserId: string;
  readonly globalRole: Role | null;
  readonly clubRoles: ReadonlyMap<string, Role>;
}

export interface PushVerifiedPlayer {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly verifiedAt: string;
  readonly method: string;
}

export interface PushJoinResult {
  readonly entryId: string;
  readonly baselineTrophies: number | null;
  readonly baselineSource: 'none' | 'player_snapshot' | 'manual_verified';
  readonly baselineCapturedAt: string | null;
}

export interface PushSubmitResult {
  readonly submissionId: string;
  readonly submittedAt: string;
  readonly trophies: number;
  readonly verificationStatus: 'unverified';
}

export type PushSubmissionSource = 'user' | 'api';
export type PushVerificationStatus = 'unverified' | 'verified';

export interface PushSubmission {
  readonly id: string;
  readonly competitionId: string;
  readonly entryId: string;
  readonly trophies: number;
  readonly source: PushSubmissionSource;
  readonly verificationStatus: PushVerificationStatus;
  readonly accepted: boolean;
  readonly submittedByProfileId: string | null;
  readonly submittedAt: string;
  readonly verifiedSnapshotId: string | null;
  readonly verifiedByProfileId: string | null;
}

export interface PushEntry {
  readonly id: string;
  readonly competitionId: string;
  readonly player: PlayerIdentity;
  readonly joinedAt: string;
  readonly baselineTrophies: number | null;
  readonly baselineSource: 'none' | 'player_snapshot' | 'manual_verified';
  readonly baselineCapturedAt: string | null;
}

export interface PushLeaderboardRow {
  /** Null for entries with no accepted submission or no usable baseline. */
  readonly rank: number | null;
  readonly entry: PushEntry;
  readonly trophies: number | null;
  readonly gain: number | null;
  readonly latestSubmissionAt: string | null;
  readonly verificationStatus: PushVerificationStatus | null;
}

export interface PushLeaderboardView {
  readonly competition: PushCompetitionRecord;
  readonly rows: readonly PushLeaderboardRow[];
  readonly generatedAt: string;
}

export interface PushCreateInput {
  readonly discordUserId: string;
  readonly name: string;
  readonly description: string | null;
  readonly start: string;
  readonly end: string;
  readonly clubId: string | null;
  readonly goal: number | null;
}

export interface PushJoinInput {
  readonly discordUserId: string;
  readonly competitionId: string;
  readonly playerId: string;
}

export interface PushSubmitInput {
  readonly discordUserId: string;
  readonly competitionId: string;
  readonly playerId: string;
  readonly trophies: number;
}

export interface PushEndInput {
  readonly discordUserId: string;
  readonly competitionId: string;
}
