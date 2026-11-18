/** Read-only view models used by the club information commands. */

export interface ClubRecord {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly description: string | null;
  readonly trophies: number | null;
  readonly requiredTrophies: number | null;
  readonly memberCount: number | null;
  readonly lastSyncedAt: string | null;
}

export interface RosterMember {
  readonly tag: string;
  readonly name: string;
  readonly trophies: number | null;
  readonly role: string | null;
}

export interface ClubSnapshot {
  readonly id: string;
  readonly syncRunId: string;
  readonly capturedAt: string;
  readonly trophies: number | null;
  readonly memberCount: number | null;
  readonly raw: unknown;
}

export interface SyncRunRecord {
  readonly id: string;
  readonly status: 'completed';
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly affectedClubIds: readonly string[];
  readonly clubTags: readonly string[];
}

export type RosterSource = 'live' | 'snapshot' | 'memberships' | 'none';
export type ApiIssue = 'rate-limit' | 'unauthorized' | 'error';

export interface ClubView {
  readonly club: ClubRecord;
  readonly roster: readonly RosterMember[];
  readonly rosterAvailable: boolean;
  readonly rosterSource: RosterSource;
  readonly snapshots: readonly ClubSnapshot[];
  readonly currentTrophies: number | null;
  readonly currentAt: string;
  readonly description: string | null;
  readonly requiredTrophies: number | null;
  readonly latestSyncAt: string | null;
  readonly liveStatus: 'live' | 'sync-only';
  readonly apiIssue: ApiIssue | null;
}

export interface ClubSummary {
  readonly club: ClubRecord;
  readonly totalTrophies: number | null;
  readonly averageTrophies: number | null;
  readonly memberCount: number | null;
  readonly latestSyncAt: string | null;
}

export type LoadClubResult =
  | { readonly kind: 'ok'; readonly view: ClubView }
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'no-default' }
  | { readonly kind: 'unregistered'; readonly tag: string };
