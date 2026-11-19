import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config';
import { buildSyncResultEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import {
  loadSyncRun,
  recordSyncRunAudit,
  requireGlobalPermission,
} from '../admin/service';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import { checkBotRateLimit } from '../discord/rate-limit';
import { runSync } from '@brawlhub/sync';
import { runManagedSync } from '../sync/guard';

const COMMAND_NAME = 'sync';
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60_000;

export const syncCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription("Run this server's BrawlHub club synchronisation");

function websiteLine(): string | undefined {
  const appUrl = getBotConfig().appUrl;
  return appUrl === undefined ? undefined : `BrawlHub website: ${appUrl}`;
}

export async function handleSync(interaction: ChatInputCommandInteraction): Promise<void> {
  let deferred = false;
  try {
    await interaction.deferReply({ ephemeral: true });
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
    const outcome = await runManagedSync({ run: () => runSync({ guildId: interaction.guildId! }).then((r) => [r]) });
    const site = websiteLine();
    if (outcome.kind === 'overlap') {
      await interaction.editReply({
        content: [
          'A sync is already running in this bot process. Use `/sync-status` to inspect it.',
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
    await recordSyncRunAudit(actor, result);
    const run = result.syncRunId === '' ? null : await loadSyncRun(result.syncRunId);
    await interaction.editReply({
      ...(site === undefined ? {} : { content: site }),
      embeds: [buildSyncResultEmbed(result, run)],
      allowedMentions: { parse: [] },
    });
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
