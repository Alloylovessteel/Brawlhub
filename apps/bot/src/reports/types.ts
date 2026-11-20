/** Shared, guild-scoped report shapes. All values originate from stored sync history. */
export interface ReportClubSummary {
  readonly clubId: string;
  readonly tag: string;
  readonly name: string;
  readonly joins: number;
  readonly leaves: number;
  readonly transfers: number;
  readonly roleChanges: number;
  readonly capacityOpens: number;
  readonly capacityCloses: number;
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
  capacityOpens: number;
  capacityCloses: number;
}
