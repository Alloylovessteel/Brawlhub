import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '@brawlhub/logging';
import { getBotConfig } from '../config';
import { buildSyncResultEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import { refreshOverviewNow } from '../clubs/overview/service';
import { refreshTodayClubLogDigest } from '../clubs/logs/poster';
import {
  loadSyncRun,
  recordSyncRunAudit,
  requireGlobalPermission,
} from '../admin/service';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import { checkBotRateLimit } from '../discord/rate-limit';
import { notifySyncResult } from '../operator-notifier.js';
import { runSync, type SyncResult } from '@brawlhub/sync';
import { runManagedSync } from '../sync/guard';
import { handleSyncStatus } from './sync-status.js';

const COMMAND_NAME = 'sync';
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60_000;
const logger = createLogger('bot');

export const syncCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription("Run or inspect this server's BrawlHub club synchronisation")
  .addSubcommand((subcommand) =>
    subcommand
      .setName('run')
      .setDescription("Run this server's BrawlHub club synchronisation")
      .addBooleanOption((option) =>
        option
          .setName('force')
          .setDescription('Re-run even if this 15-minute period already completed')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Show the latest stored synchronisation status for this server'),
  );

export async function handleSyncCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommand(false) === 'status') {
    await handleSyncStatus(interaction);
    return;
  }
  await handleSync(interaction, interaction.options.getBoolean('force') ?? false);
}

function websiteLine(): string | undefined {
  const appUrl = getBotConfig().appUrl;
  return appUrl === undefined ? undefined : `BrawlHub website: ${appUrl}`;
}

async function postOperatorNotice(result: SyncResult): Promise<void> {
  try {
    await notifySyncResult(result);
  } catch {
    // Operator notices are best-effort and must never fail the sync command.
  }
}

/** Refresh the posted daily club log in place after a successful manual sync. */
async function refreshDailyClubLogAfterSync(result: SyncResult, guildId: string): Promise<void> {
  if (result.status !== 'completed' && result.status !== 'skipped') return;
  try {
    await refreshTodayClubLogDigest(guildId);
  } catch (error) {
    // The regular digest remains valid; never fail a sync over a refresh.
    logger.warn('Could not refresh daily club log after manual sync', {
      guildId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

/** Refresh the auto-posted overview immediately after a completed or skipped manual sync. */
async function refreshOverviewAfterSync(
  interaction: ChatInputCommandInteraction,
  result: SyncResult,
): Promise<void> {
  if (result.status !== 'completed' && result.status !== 'skipped') return;
  try {
    await refreshOverviewNow(interaction.guildId!, {
      label: interaction.guild?.name ?? null,
      iconUrl: interaction.guild?.iconURL() ?? null,
    });
  } catch (error) {
    // The regular overview timer will retry; never fail a completed sync over this.
    logger.warn('Could not refresh club overview after manual sync', {
      guildId: interaction.guildId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

export async function handleSync(
  interaction: ChatInputCommandInteraction,
  force = false,
): Promise<void> {
  let deferred = false;
  try {
    await interaction.deferReply({ flags: 64 });
    deferred = true;

    if (interaction.guildId === null) {
      await interaction.editReply({
        content: 'Sync can only be run from within a Discord server.',
      });
      return;
    }

    const actor = await requireGlobalPermission(interaction.user.id, 'sync:run', {
      guildId: interaction.guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });

    const rateLimit = checkBotRateLimit(
      `admin-sync:${interaction.user.id}:${interaction.guildId}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      const site = websiteLine();
      await interaction.editReply({
        content: [
          `Too many sync requests. Try again in ${rateLimit.retryAfterSeconds} second(s).`,
          site,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n'),
      });
      return;
    }

    // Run only this guild to preserve per-server isolation for manual syncs.
    const outcome = await runManagedSync({
      run: () => runSync({ guildId: interaction.guildId!, force }).then((r) => [r]),
    });
    const site = websiteLine();
    if (outcome.kind === 'overlap') {
      await interaction.editReply({
        content: [
          'A sync is already running in this bot process. Use `/sync status` to inspect it.',
          site,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n'),
      });
      return;
    }

    const result = outcome.results[0];
    if (result === undefined) {
      await interaction.editReply({
        content: ['Sync did not produce a result.', site]
          .filter((line): line is string => line !== undefined)
          .join('\n'),
      });
      return;
    }
    await recordSyncRunAudit(actor, result, { guildId: interaction.guildId });
    // Start the follow-ups together. The deferred reply only waits for stored
    // run details, so a slow Discord image edit cannot keep /sync run pending.
    const followUps = [
      refreshOverviewAfterSync(interaction, result),
      refreshDailyClubLogAfterSync(result, interaction.guildId),
      postOperatorNotice(result),
    ];
    const run = result.syncRunId === '' ? null : await loadSyncRun(result.syncRunId);
    await interaction.editReply({
      ...(site === undefined ? {} : { content: site }),
      embeds: [buildSyncResultEmbed(result, run)],
      allowedMentions: { parse: [] },
    });
    await Promise.allSettled(followUps);
  } catch (error) {
    if (!deferred) {
      await replyAdminError(interaction, error);
      return;
    }
    try {
      await replyAdminError(interaction, error);
    } catch {
      try {
        const site = websiteLine();
        await interaction.editReply({
          content: ['Sync could not be completed. Check logs for details.', site]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        });
      } catch {
        // ignore
      }
    }
  }
}
