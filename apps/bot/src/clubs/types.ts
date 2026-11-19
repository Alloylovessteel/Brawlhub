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

export interface TrophyProgression {
  readonly today: number | null;
  readonly week: number | null;
  readonly season: number | null;
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

export interface MatchActivity {
  readonly today: number | null;
  readonly week: number | null;
  readonly season: number | null;
  readonly sampleSize: number;
  readonly lastBattleAt: string | null;
}

export interface MegaPigEstimate {
  readonly matches: number;
  readonly wins: number;
  readonly trophyChange: number;
  readonly sampleSize: number;
  readonly windowStart: string;
  readonly windowEnd: string;
}

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
  readonly type: string | null;
  readonly badgeId: number | null;
  readonly matchActivity: MatchActivity | null;
  readonly megaPigEstimate: MegaPigEstimate | null;
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
  /** President from the synced roster, when a roster is available. */
  readonly leader: { readonly name: string; readonly tag: string } | null;
  /** Lowest and highest member trophies from the synced roster. */
  readonly trophyRange: { readonly low: number; readonly high: number } | null;
  /** Lowest and highest stored ranked rank names from roster players. */
  readonly rankedRange: { readonly low: string; readonly high: string } | null;
  /** Null when the Mega Pig window is not configured. */
  readonly megaPigEstimate: MegaPigEstimate | null;
  /** Roster players with a stored battle in the last 24 hours; not live online status. */
  readonly activeMembers24h: number | null;
}

export type LoadClubResult =
  | { readonly kind: 'ok'; readonly view: ClubView }
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'no-default' }
  | { readonly kind: 'unregistered'; readonly tag: string };

/** Shared failure cases for commands that resolve a registered club by tag. */
export type ClubLookupFailure =
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'no-default' }
  | { readonly kind: 'unregistered'; readonly tag: string }
  | { readonly kind: 'same-club' };

export type ResolvedClubResult<T> =
  | ClubLookupFailure
  | { readonly kind: 'ok'; readonly value: T };

/** Stored player row. `highest_trophies` is nullable and never inferred. */
export interface PlayerRecord {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly trophies: number | null;
  readonly highestTrophies: number | null;
}

export interface MemberDetail extends RosterMember {
  readonly playerId: string | null;
  readonly highestTrophies: number | null;
}

export interface LeaderboardEntry extends MemberDetail {
  readonly rank: number;
  readonly progression: TrophyProgression | null;
}

/** Read-only synced data shared by the advanced club commands. */
export interface SyncedClubView {
  readonly club: ClubRecord;
  readonly snapshots: readonly ClubSnapshot[];
  readonly completedRunIds: ReadonlySet<string>;
  readonly latestSnapshot: ClubSnapshot | null;
  readonly roster: readonly RosterMember[];
  readonly rosterSource: 'snapshot' | 'memberships' | 'none';
  readonly latestSyncAt: string | null;
}

export interface MemberView extends SyncedClubView {
  readonly members: readonly MemberDetail[];
}

export interface LeaderboardView extends SyncedClubView {
  readonly entries: readonly LeaderboardEntry[];
}

export type ClubLogPeriod = 'today' | 'week' | 'season';

export interface ClubLogRow {
  readonly rank: number;
  readonly member: MemberDetail;
  readonly change: number;
}

export interface ClubLogView {
  readonly club: ClubRecord;
  readonly period: ClubLogPeriod;
  readonly rows: readonly ClubLogRow[];
  readonly unavailable: number;
  readonly latestSnapshotAt: string | null;
  readonly latestSyncAt: string | null;
}

export type HistoryPeriod = '7d' | '30d' | '90d' | 'all';

export interface HistoryPoint {
  readonly capturedAt: string;
  readonly syncRunId: string;
  readonly trophies: number | null;
  readonly averageTrophies: number | null;
  readonly memberCount: number | null;
}

export interface HistoryChange {
  readonly trophies: number | null;
  readonly averageTrophies: number | null;
  readonly memberCount: number | null;
}

export interface MembershipChange {
  readonly detectedAt: string;
  readonly eventType: 'join' | 'leave' | 'transfer';
  readonly playerName: string | null;
  readonly playerTag: string | null;
}

export interface HistoryView extends SyncedClubView {
  readonly period: HistoryPeriod;
  readonly points: readonly HistoryPoint[];
  readonly latestSnapshotAt: string | null;
  readonly rangeStart: string | null;
  readonly rangeEnd: string | null;
  readonly change: HistoryChange | null;
  readonly progression: TrophyProgression | null;
  readonly membershipChanges: readonly MembershipChange[];
}

export interface ComparisonSide {
  readonly club: ClubRecord;
  readonly trophies: number | null;
  readonly averageTrophies: number | null;
  readonly memberCount: number | null;
  readonly highestTrophies: number | null;
  readonly lowestTrophies: number | null;
  readonly progression: TrophyProgression | null;
  readonly latestSyncAt: string | null;
  readonly snapshotAt: string | null;
  readonly syncRunId: string | null;
}

export interface ComparisonView {
  readonly first: ComparisonSide;
  readonly second: ComparisonSide;
  readonly aligned: boolean;
}
