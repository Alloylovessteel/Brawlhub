/** Official Brawl Stars club capacity; a club is full at this count. */
export const CLUB_CAPACITY = 30;

/** Shared, guild-scoped report shapes. All values originate from stored sync history. */
export interface ReportClubCapacity {
  /** Null when the guild has no completed snapshot for this club yet. */
  readonly memberCount: number | null;
  readonly capturedAt: string | null;
}

export interface ReportClubSummary {
  readonly clubId: string;
  readonly tag: string;
  readonly name: string;
  readonly joins: number;
  readonly leaves: number;
  readonly transfers: number;
  readonly roleChanges: number;
  /** Current capacity from the latest completed snapshot, not transition events. */
  readonly capacity: ReportClubCapacity;
}

export interface ReportPostRow {
  readonly messageId: string | null;
  readonly channelId: string | null;
}

export interface MutableClubSummary {
  clubId: string;
  tag: string;
  name: string;
  joins: number;
  leaves: number;
  transfers: number;
  roleChanges: number;
  capacity: {
    memberCount: number | null;
    capturedAt: string | null;
  };
}
