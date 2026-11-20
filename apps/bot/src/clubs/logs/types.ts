/** Stored, guild-scoped club log configuration and derived event views. */

export interface ClubLogConfig {
  readonly id: string;
  readonly guildId: string;
  readonly clubId: string;
  readonly clubTag: string;
  readonly clubName: string;
  readonly channelId: string;
}

/** Internal row with the subscription timestamp used as the event watermark. */
export interface ClubLogRow extends ClubLogConfig {
  readonly createdAt: string;
}

export type ClubLogEventKind = 'membership' | 'role' | 'capacity';

export interface ClubLogEvent {
  readonly kind: ClubLogEventKind;
  readonly id: string;
  readonly clubId: string;
  readonly playerTag: string | null;
  readonly playerName: string | null;
  readonly description: string;
  readonly detectedAt: string;
}

export interface ClubLogDelivery {
  readonly logId: string;
  readonly kind: ClubLogEventKind;
  readonly eventId: string;
}

export interface ClubLogGroup {
  readonly log: ClubLogConfig;
  readonly events: ClubLogEvent[];
}
