import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { replyWithSafeError } from '../discord/errors';
import { buildStatusEmbed } from '../info/embed';
import { loadStatusView } from '../status/service';

export const statusCommandData = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show safe public operational status for BrawlHub');

/** Public command: it reports only generic health states, never raw errors or configuration. */
export async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const view = await loadStatusView({ guildId: interaction.guildId });
    await interaction.reply({
      embeds: [buildStatusEmbed(view)],
      allowedMentions: { parse: [] },
    });
  } catch {
    await replyWithSafeError(interaction);
  }
}
