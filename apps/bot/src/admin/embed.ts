import type { SyncResult } from '@brawlhub/sync';
import { EmbedBuilder } from 'discord.js';
import type { Page } from '../discord/pagination';
import type {
  AuditLogEntry,
  AuditLogView,
  ClubRegistrationPreview,
  GuildRoleMappingView,
  GuildSettingsView,
  SyncRunSummary,
  SyncStatusView,
} from './types';

const INLINE = true;
const MAX_FIELD_LENGTH = 1000;

function text(value: string | number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).slice(0, MAX_FIELD_LENGTH);
}

function timestamp(value: string | null): string {
  if (value === null) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? text(value) : `<t:${Math.floor(parsed / 1000)}:f>`;
}

function detailsText(details: Record<string, unknown> | null): string {
  if (details === null) return '';
  try {
    return JSON.stringify(details).slice(0, 400);
  } catch {
    return '';
  }
}

export function buildClubRegistrationPreviewEmbed(
  preview: ClubRegistrationPreview,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('Confirm club registration')
    .setDescription('Verify the official Brawl Stars club below before confirming.')
    .addFields(
      { name: 'Club', value: text(preview.name), inline: INLINE },
      { name: 'Tag', value: `#${preview.tag}`, inline: INLINE },
      { name: 'Trophies', value: text(preview.trophies), inline: INLINE },
      { name: 'Members', value: text(preview.memberCount), inline: INLINE },
    );
}

export function buildClubRegisteredEmbed(preview: ClubRegistrationPreview): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f2_87)
    .setTitle('Club registered')
    .setDescription(`${text(preview.name)} (#${preview.tag}) is now registered with BrawlHub.`);
}

export function buildSyncResultEmbed(result: SyncResult, run: SyncRunSummary | null): EmbedBuilder {
  const color = result.status === 'failed' ? 0xed_4245 : result.status === 'skipped' ? 0xfaa_61a : 0x57f2_87;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(result.status === 'completed' ? 'Sync completed' : result.status === 'failed' ? 'Sync failed' : 'Sync skipped')
    .addFields(
      { name: 'Status', value: result.status, inline: INLINE },
      { name: 'Run', value: text(result.syncRunId), inline: INLINE },
      { name: 'Clubs processed', value: text(result.clubsProcessed), inline: INLINE },
      { name: 'Affected clubs', value: text(result.affectedClubIds.length), inline: INLINE },
      { name: 'Players upserted', value: text(result.playersUpserted), inline: INLINE },
      { name: 'Snapshots written', value: text(result.snapshotsWritten), inline: INLINE },
      { name: 'Membership events', value: text(result.membershipEvents), inline: INLINE },
      { name: 'Started', value: timestamp(run?.startedAt ?? null), inline: INLINE },
      { name: 'Finished', value: timestamp(run?.finishedAt ?? null), inline: INLINE },
    );

  if (result.error !== undefined) {
    embed.addFields({ name: 'Error', value: text(result.error) });
  }
  return embed;
}

export function buildSyncStatusEmbed(view: SyncStatusView): EmbedBuilder {
  const run = view.latestRun;
  const embed = new EmbedBuilder()
    .setColor(view.lock.active ? 0xfaa_61a : 0x5865_f2)
    .setTitle('Synchronisation status')
    .addFields(
      { name: 'Currently running', value: view.lock.active ? 'Yes' : 'No', inline: INLINE },
      { name: 'Latest status', value: text(run?.status), inline: INLINE },
      { name: 'Start', value: timestamp(run?.startedAt ?? null), inline: INLINE },
      { name: 'Completed', value: timestamp(run?.finishedAt ?? null), inline: INLINE },
      { name: 'Affected clubs', value: text(run?.affectedClubIds.length ?? 0), inline: INLINE },
      { name: 'Successful clubs', value: 'Not recorded by the current schema', inline: INLINE },
      { name: 'Failed clubs', value: 'Not recorded; see run error', inline: INLINE },
      { name: 'Records processed', value: text(run?.recordsProcessed ?? 0), inline: INLINE },
    );

  if (run !== null && run.clubTags.length > 0) {
    embed.addFields({ name: 'Club tags', value: text(run.clubTags.map((tag) => `#${tag}`).join(', ')) });
  }
  const error = run === null ? null : (run.error ?? run.lastError);
  if (error !== null) {
    embed.addFields({ name: 'Error', value: text(error) });
  }
  return embed;
}

export function buildSettingsViewEmbed(
  settings: GuildSettingsView,
  roleMappings: readonly GuildRoleMappingView[] = [],
): EmbedBuilder {
  const mappingValue =
    roleMappings.length === 0
      ? 'Not configured. Use `/settings set-role-mapping` to map Discord roles to BrawlHub roles.'
      : roleMappings
          .slice(0, 10)
          .map((mapping) => `<@&${mapping.discordRoleId}> → **${mapping.brawlhubRole}**`)
          .join('\n');

  return new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('Guild settings')
    .setDescription(`Settings for guild \`${settings.guildId}\`.`)
    .addFields(
      {
        name: 'Primary club',
        value:
          settings.primaryClubTag === null
            ? 'Not configured'
            : `${text(settings.primaryClubName)} (#${settings.primaryClubTag})`,
        inline: INLINE,
      },
      {
        name: 'Announcement channel',
        value: settings.announcementChannelId === null ? 'Not configured' : `<#${settings.announcementChannelId}>`,
        inline: INLINE,
      },
      {
        name: 'Verified role',
        value: settings.verifiedRoleId === null ? 'Not configured' : `<@&${settings.verifiedRoleId}>`,
        inline: INLINE,
      },
      {
        name: 'Role mappings',
        value: mappingValue.slice(0, MAX_FIELD_LENGTH),
      },
      { name: 'Updated', value: timestamp(settings.updatedAt), inline: INLINE },
    );
}

export function buildRoleMappingsEmbed(
  guildId: string,
  roleMappings: readonly GuildRoleMappingView[],
  notice?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('Discord role mappings')
    .setDescription(
      `Configured BrawlHub role mappings for guild \`${guildId}\`. ${notice ?? 'These mappings grant BrawlHub permissions in this server.'}`.slice(
        0,
        4000,
      ),
    );

  if (roleMappings.length === 0) {
    embed.addFields({
      name: 'Mappings',
      value: 'None configured. Use `/settings set-role-mapping` to add one (e.g. club leaders role → admin/staff).',
    });
    return embed;
  }

  embed.addFields({
    name: `Mappings (${roleMappings.length})`,
    value: roleMappings
      .map((mapping) => `• <@&${mapping.discordRoleId}> → **${mapping.brawlhubRole}**`)
      .join('\n')
      .slice(0, MAX_FIELD_LENGTH),
  });
  return embed;
}

export function buildSettingsUpdatedEmbed(
  settings: GuildSettingsView,
  changedFields: readonly string[],
): EmbedBuilder {
  const embed = buildSettingsViewEmbed(settings);
  embed.setTitle('Guild settings updated');
  embed.setColor(0x57f2_87);
  embed.addFields({ name: 'Changed', value: text(changedFields.join(', '), 'None') });
  return embed;
}

function auditEntryValue(entry: AuditLogEntry, index: number): string {
  const details = detailsText(entry.details);
  return [
    `'${index}' ${entry.action}`,
    `Actor: ${entry.actorLabel}`,
    `Target: ${text(entry.targetType)} / ${text(entry.targetId)}`,
    `Time: ${timestamp(entry.createdAt)}`,
    ...(details === '' ? [] : [`Details: \`${details}\``]),
  ].join('\n');
}

export function buildAuditPageEmbed(view: AuditLogView, page: Page<AuditLogEntry>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('BrawlHub audit log')
    .setDescription(`Page ${page.page} of ${page.pageCount} — ${page.total} record(s). Read-only.`);

  if (page.items.length === 0) {
    embed.addFields({ name: 'No records', value: 'No audit entries are available.' });
    return embed;
  }

  page.items.forEach((entry, index) => {
    embed.addFields({
      name: `Entry ${page.start + index}`,
      value: auditEntryValue(entry, page.start + index).slice(0, MAX_FIELD_LENGTH),
    });
  });
  return embed;
}

export function buildClubRemovalUnavailableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfaa_61a)
    .setTitle('Club removal is unavailable')
    .setDescription(
      'The current schema has no archival state. Deleting a club would cascade-delete snapshots, memberships and roles, so destructive removal is intentionally disabled. A safe archival migration is required before this command can be enabled.',
    );
}
