import {
  mdBold,
  mdCode,
  mdLabelLines,
  mdList,
  mdParagraphs,
  mdSection,
} from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import type { SyncResult } from '@brawlhub/sync';
import { EmbedBuilder } from 'discord.js';
import { OVERVIEW_FIELD_LABELS } from '../clubs/overview/fields';
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
    .setColor(EMBED_COLORS.neutral)
    .setTitle('Confirm club registration')
    .setDescription(
      mdSection('Before you confirm', 'Verify the official Brawl Stars club below before confirming.'),
    )
    .addFields(
      { name: 'Club', value: text(preview.name), inline: INLINE },
      { name: 'Tag', value: mdCode(`#${preview.tag}`), inline: INLINE },
      { name: 'Trophies', value: text(preview.trophies), inline: INLINE },
      { name: 'Members', value: text(preview.memberCount), inline: INLINE },
    );
}

export function buildClubRegisteredEmbed(preview: ClubRegistrationPreview): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.success)
    .setTitle('Club registered')
    .setDescription(
      `${text(preview.name)} (${mdCode(`#${preview.tag}`)}) is now registered with BrawlHub.`,
    );
}

export function buildSyncResultEmbed(result: SyncResult, run: SyncRunSummary | null): EmbedBuilder {
  const color = result.status === 'failed' ? EMBED_COLORS.danger : result.status === 'skipped' ? EMBED_COLORS.warning : EMBED_COLORS.success;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(result.status === 'completed' ? 'Sync completed' : result.status === 'failed' ? 'Sync failed' : 'Sync skipped')
    .addFields(
      { name: 'Status', value: mdCode(result.status), inline: INLINE },
      { name: 'Run', value: mdCode(text(result.syncRunId)), inline: INLINE },
      { name: 'Clubs processed', value: text(result.clubsProcessed), inline: INLINE },
      { name: 'Affected clubs', value: text(result.affectedClubIds.length), inline: INLINE },
      { name: 'Players upserted', value: text(result.playersUpserted), inline: INLINE },
      { name: 'Snapshots written', value: text(result.snapshotsWritten), inline: INLINE },
      { name: 'Membership events', value: text(result.membershipEvents), inline: INLINE },
      { name: 'Started', value: timestamp(run?.startedAt ?? null), inline: INLINE },
      { name: 'Finished', value: timestamp(run?.finishedAt ?? null), inline: INLINE },
    );

  if (result.error !== undefined) {
    embed.addFields({ name: 'Error', value: mdCode(text(result.error)) });
  }
  return embed;
}

export function buildSyncStatusEmbed(view: SyncStatusView): EmbedBuilder {
  const run = view.latestRun;
  const embed = new EmbedBuilder()
    .setColor(view.lock.active ? EMBED_COLORS.warning : EMBED_COLORS.neutral)
    .setTitle('Synchronisation status')
    .addFields(
      { name: 'Currently running', value: view.lock.active ? 'Yes' : 'No', inline: INLINE },
      { name: 'Latest status', value: mdCode(text(run?.status)), inline: INLINE },
      { name: 'Start', value: timestamp(run?.startedAt ?? null), inline: INLINE },
      { name: 'Completed', value: timestamp(run?.finishedAt ?? null), inline: INLINE },
      { name: 'Affected clubs', value: text(run?.affectedClubIds.length ?? 0), inline: INLINE },
      { name: 'Successful clubs', value: 'Not recorded by the current schema', inline: INLINE },
      { name: 'Failed clubs', value: 'Not recorded; see run error', inline: INLINE },
      { name: 'Records processed', value: text(run?.recordsProcessed ?? 0), inline: INLINE },
    );

  if (run !== null && run.clubTags.length > 0) {
    embed.addFields({
      name: 'Club tags',
      value: text(mdList(run.clubTags.map((tag) => mdCode(`#${tag}`)))),
    });
  }
  const error = run?.error ?? null;
  if (error !== null) {
    embed.addFields({ name: 'Error', value: mdCode(text(error)) });
  } else if (run !== null && run.lastError !== null) {
    // `last_error` is retained across retries by design (migration 0004). Only
    // present it as the active error when the run actually failed, otherwise
    // label it so an in-progress sync isn't shown as broken.
    embed.addFields({
      name: run.status === 'failed' ? 'Error' : 'Previous error',
      value: mdCode(text(run.lastError)),
    });
  }
  return embed;
}

export function buildSettingsViewEmbed(
  settings: GuildSettingsView,
  roleMappings: readonly GuildRoleMappingView[] = [],
): EmbedBuilder {
  const mappingValue =
    roleMappings.length === 0
      ? `Not configured. Use ${mdCode('/settings set-role-mapping')} to map Discord roles to BrawlHub roles.`
      : mdList(
          roleMappings
            .slice(0, 10)
            .map((mapping) => `<@&${mapping.discordRoleId}> → **${mapping.brawlhubRole}**`),
        );

  return new EmbedBuilder()
    .setColor(EMBED_COLORS.neutral)
    .setTitle('Guild settings')
    .setDescription(mdSection('Scope', `Settings for guild ${mdCode(settings.guildId)}.`))
    .addFields(
      {
        name: 'Announcement channel',
        value: settings.announcementChannelId === null ? 'Not configured' : `<#${settings.announcementChannelId}>`,
        inline: INLINE,
      },
      {
        name: 'Overview channel',
        value: settings.overviewChannelId === null ? 'Not configured' : `<#${settings.overviewChannelId}>`,
        inline: INLINE,
      },
      {
        name: 'Verified role',
        value: settings.verifiedRoleId === null ? 'Not configured' : `<@&${settings.verifiedRoleId}>`,
        inline: INLINE,
      },
      {
        name: 'Overview sections',
        value: text(
          mdList(
            settings.overviewFields
              .map((field) => OVERVIEW_FIELD_LABELS[field])
              .filter((label): label is string => label !== undefined),
          ),
          'All defaults',
        ),
      },
      {
        name: 'Daily report channel',
        value:
          settings.reportDailyChannelId === null
            ? 'Overview channel'
            : `<#${settings.reportDailyChannelId}>`,
        inline: INLINE,
      },
      {
        name: 'Weekly report channel',
        value:
          settings.reportWeeklyChannelId === null
            ? 'Overview channel'
            : `<#${settings.reportWeeklyChannelId}>`,
        inline: INLINE,
      },
      {
        name: 'Monthly report channel',
        value:
          settings.reportMonthlyChannelId === null
            ? 'Overview channel'
            : `<#${settings.reportMonthlyChannelId}>`,
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
    .setColor(EMBED_COLORS.neutral)
    .setTitle('Discord role mappings')
    .setDescription(
      mdParagraphs(
        `Configured BrawlHub role mappings for guild ${mdCode(guildId)}.`,
        notice ?? 'These mappings grant BrawlHub permissions in this server.',
      ).slice(0, 4000),
    );

  if (roleMappings.length === 0) {
    embed.addFields({
      name: 'Mappings',
      value: `None configured. Use ${mdCode('/settings set-role-mapping')} to add one (e.g. club leaders role → admin/staff).`,
    });
    return embed;
  }

  embed.addFields({
    name: `Mappings (${roleMappings.length})`,
    value: text(
      mdList(
        roleMappings.map(
          (mapping) => `<@&${mapping.discordRoleId}> → **${mapping.brawlhubRole}**`,
        ),
      ),
    ),
  });
  return embed;
}

export function buildSettingsUpdatedEmbed(
  settings: GuildSettingsView,
  changedFields: readonly string[],
): EmbedBuilder {
  const embed = buildSettingsViewEmbed(settings);
  embed.setTitle('Guild settings updated');
  embed.setColor(EMBED_COLORS.success);
  embed.addFields({
    name: 'Changed',
    value: text(mdList(changedFields.map((field) => mdCode(field))), 'None'),
  });
  return embed;
}

function auditEntryValue(entry: AuditLogEntry, index: number): string {
  const details = detailsText(entry.details);
  return mdSection(
    `'${index}' ${mdCode(entry.action)}`,
    mdLabelLines([
      `Actor: ${entry.actorLabel}`,
      `Target: ${text(entry.targetType)} / ${text(entry.targetId)}`,
      `Time: ${timestamp(entry.createdAt)}`,
      ...(details === '' ? [] : [`Details: ${mdCode(details)}`]),
    ]),
  );
}

export function buildAuditPageEmbed(view: AuditLogView, page: Page<AuditLogEntry>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.neutral)
    .setTitle('BrawlHub audit log')
    .setDescription(
      mdParagraphs(
        mdBold(`Page ${page.page} of ${page.pageCount} — ${page.total} record(s).`),
        'Read-only.',
      ),
    );

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

export function buildClubArchivePreviewEmbed(clubName: string, clubTag: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.warning)
    .setTitle('Archive club?')
    .setDescription(
      mdSection(
        'Details',
        mdParagraphs(
          `${clubName} (${mdCode(`#${clubTag}`)}) will be hidden from this server’s commands and overview.`,
          'Snapshots, memberships, roles and history are kept; this does not delete data.',
          'The tag can be registered again later.',
        ),
      ),
    );
}

export function buildClubArchivedEmbed(clubName: string, clubTag: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.success)
    .setTitle('Club archived')
    .setDescription(
      `${clubName} (${mdCode(`#${clubTag}`)}) is no longer active in this server.`,
    );
}

/** @deprecated Kept for compatibility; archival is now available. */
export function buildClubRemovalUnavailableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.warning)
    .setTitle('Club removal is unavailable')
    .setDescription(
      mdParagraphs(
        'The current schema has no archival state.',
        'Deleting a club would cascade-delete snapshots, memberships and roles, so destructive removal is intentionally disabled.',
        'A safe archival migration is required before this command can be enabled.',
      ),
    );
}
