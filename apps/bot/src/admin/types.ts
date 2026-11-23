import type { Permission, Role } from '@brawlhub/shared';
import type { ClubRegistrationPreview } from '@brawlhub/sync';
import type { OverviewFieldKey } from '../clubs/overview/fields';
import type { StaffActor } from '../staff/types';

/** Administration always resolves a Discord-linked profile with a global role. */
export type AdminActor = StaffActor;

export type { ClubRegistrationPreview };

export interface GuildSettingsView {
  readonly guildId: string;
  readonly announcementChannelId: string | null;
  readonly verifiedRoleId: string | null;
  /** Channel that receives the auto-updating club overview message. */
  readonly overviewChannelId: string | null;
  /** Internal: Discord message ID of the posted overview (not user-settable). */
  readonly overviewMessageId: string | null;
  /** Enabled overview sections; empty means all defaults. */
  readonly overviewFields: readonly OverviewFieldKey[];
  /** Optional per-report channel overrides; null falls back to the overview channel. */
  readonly reportDailyChannelId: string | null;
  readonly reportWeeklyChannelId: string | null;
  readonly reportMonthlyChannelId: string | null;
  /** Phase 4: official ranked tier to Discord role mapping for this guild. */
  readonly rankedRoleIds: Readonly<Record<string, string>>;
  /** Phase 4: where this guild's verification message was posted. */
  readonly verificationChannelId: string | null;
  readonly verificationMessageId: string | null;
  readonly updatedAt: string | null;
}

export interface GuildCustomRoleView {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly Permission[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface GuildRoleMappingView {
  readonly guildId: string;
  readonly discordRoleId: string;
  readonly brawlhubRole: Role | null;
  readonly customRoleId: string | null;
  readonly customRoleName: string | null;
  readonly updatedAt: string | null;
  /** Resolved display label for embeds and list output. */
  readonly label: string;
}

export type GuildSettingsField =
  | 'announcementChannelId'
  | 'verifiedRoleId'
  | 'overviewChannelId'
  | 'reportDailyChannelId'
  | 'reportWeeklyChannelId'
  | 'reportMonthlyChannelId';

export interface GuildSettingsUpdate {
  readonly actor: AdminActor;
  readonly guildId: string;
  readonly field: GuildSettingsField;
  /** Null clears the field. */
  readonly value: string | null;
}

export interface GuildOverviewFieldsUpdate {
  readonly actor: AdminActor;
  readonly guildId: string;
  readonly fields: readonly OverviewFieldKey[];
}

export interface SyncRunSummary {
  readonly id: string;
  readonly status: string;
  readonly periodStart: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly lastError: string | null;
  readonly recordsProcessed: number;
  readonly affectedClubIds: readonly string[];
  readonly clubTags: readonly string[];
}

export interface SyncLockSummary {
  readonly scope: string;
  readonly lockedBy: string | null;
  readonly lockedAt: string | null;
  readonly lockedUntil: string | null;
  readonly active: boolean;
}

export interface SyncStatusView {
  readonly latestRun: SyncRunSummary | null;
  readonly lock: SyncLockSummary;
  readonly generatedAt: Date;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly actorProfileId: string | null;
  readonly actorLabel: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly details: Record<string, unknown> | null;
  readonly createdAt: string | null;
}

export interface AuditLogView {
  readonly entries: readonly AuditLogEntry[];
  readonly generatedAt: Date;
}
