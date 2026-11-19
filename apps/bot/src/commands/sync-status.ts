import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { buildSyncStatusEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import { loadSyncStatus, requireGlobalPermission } from '../admin/service';

const COMMAND_NAME = 'sync-status';

export const syncStatusCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show the latest stored synchronisation status for this server');

export async function handleSyncStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await requireGlobalPermission(interaction.user.id, 'sync:run');
    const status = await loadSyncStatus(interaction.guildId);
    await interaction.reply({
      embeds: [buildSyncStatusEmbed(status)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
