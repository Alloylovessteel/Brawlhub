/** Read-only view models for the BrawlHub membership command group. */

import type { ClubRecord } from '../clubs/types';
import type { ClubMembershipStatus, PlayerClubRef } from '../players/types';

export type MemberSearchMode = 'player' | 'discord';

export interface TrackedMemberRecord {
  readonly playerId: string;
  readonly playerTag: string;
  readonly playerName: string;
  readonly trophies: number | null;
  readonly club: PlayerClubRef;
  readonly status: ClubMembershipStatus;
}

export interface MemberListView {
  /** The optional club filter, when one was applied. */
  readonly club: ClubRecord | null;
  readonly records: readonly TrackedMemberRecord[];
  readonly currentCount: number;
  readonly historicalCount: number;
}

export interface TrackedPlayerEntry {
  readonly playerId: string;
  readonly playerTag: string;
  readonly playerName: string;
  readonly trophies: number | null;
  readonly currentClub: PlayerClubRef | null;
}

export interface MemberSearchView {
  readonly mode: MemberSearchMode;
  /** The validated query used for the search, safe to store in pagination state. */
  readonly query: string;
  readonly entries: readonly TrackedPlayerEntry[];
  /** Set only for Discord identity searches, to explain what the link means. */
  readonly identityContext: boolean;
}

export type MemberLookupFailure =
  | { readonly kind: 'invalid-tag'; readonly message: string }
  | { readonly kind: 'unregistered'; readonly tag: string; readonly message: string };

export type MemberSearchFailure =
  | { readonly kind: 'invalid-input'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'no-identity-link'; readonly message: string };

export type ResolvedMembersResult<T> =
  | MemberLookupFailure
  | { readonly kind: 'ok'; readonly value: T };

export type ResolvedMemberSearchResult<T> =
  | MemberSearchFailure
  | { readonly kind: 'ok'; readonly value: T };

export interface MembershipActor {
  readonly profileId: string | null;
  readonly discordUserId: string;
  readonly globalRole: 'owner' | 'admin' | 'staff' | 'member' | null;
}
