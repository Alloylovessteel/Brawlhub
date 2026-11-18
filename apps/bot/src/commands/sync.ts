import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { buildSyncResultEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import {
  loadSyncRun,
  recordSyncRunAudit,
  requireGlobalPermission,
} from '../admin/service';
import { checkBotRateLimit } from '../discord/rate-limit';
import { runManagedSync } from '../sync/guard';

const COMMAND_NAME = 'sync';
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60_000;

export const syncCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Run the existing all-clubs synchronisation pipeline');

export async function handleSync(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const actor = await requireGlobalPermission(interaction.user.id, 'sync:run');

    const rateLimit = checkBotRateLimit(
      `admin-sync:${interaction.user.id}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      await interaction.reply({
        content: `Too many sync requests. Try again in ${rateLimit.retryAfterSeconds} second(s).`,
        ephemeral: true,
      });
      return;
    }

    const outcome = await runManagedSync();
    if (outcome.kind === 'overlap') {
      await interaction.reply({
        content: 'A sync is already running in this bot process. Use `/sync-status` to inspect it.',
        ephemeral: true,
      });
      return;
    }

    const result = outcome.result;
    await recordSyncRunAudit(actor, result);
    const run = result.syncRunId === '' ? null : await loadSyncRun(result.syncRunId);
    await interaction.reply({
      embeds: [buildSyncResultEmbed(result, run)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
