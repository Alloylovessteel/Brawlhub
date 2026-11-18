import type { Role } from '@brawlhub/shared';
import type { createTrustedClient } from '@brawlhub/database';

/** Discord identity and stored global role of the interacting moderator. */
export interface ModerationActor {
  readonly profileId: string;
  readonly discordUserId: string;
  readonly globalRole: Role | null;
}

/** A stored Brawl Stars player that can be placed on the blacklist. */
export interface BlacklistTarget {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
}

/** One blacklist row joined to its player and creator identity. */
export interface BlacklistEntry {
  readonly id: string;
  readonly playerId: string | null;
  readonly playerTag: string | null;
  readonly playerName: string | null;
  readonly reason: string;
  readonly createdByProfileId: string | null;
  readonly createdByDiscordId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly removedAt: string | null;
}

export interface AddBlacklistInput {
  readonly discordUserId: string;
  readonly tag: string;
  readonly reason: string;
}

export interface RemoveBlacklistInput {
  readonly discordUserId: string;
  readonly blacklistId: string;
  readonly reason?: string | null;
}

export interface ListBlacklistsInput {
  readonly search?: string | null;
}

export interface BlacklistListView {
  readonly entries: readonly BlacklistEntry[];
  readonly generatedAt: Date;
}

export interface AddBlacklistResult {
  readonly id: string;
  readonly player: BlacklistTarget;
  readonly reason: string;
  readonly createdAt: string;
}

export interface RemoveBlacklistResult {
  readonly id: string;
  readonly removedAt: string;
}

export interface ModerationServiceOptions {
  readonly db?: ReturnType<typeof createTrustedClient>;
  /** Discord ID of the moderator for reads, which have no input actor field. */
  readonly actorDiscordUserId?: string;
}
