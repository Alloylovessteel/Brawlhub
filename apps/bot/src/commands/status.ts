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
    await interaction.deferReply();
    const view = await loadStatusView({ guildId: interaction.guildId });
    await interaction.editReply({
      embeds: [buildStatusEmbed(view)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: 'Something went wrong. Please try again later.',
        embeds: [],
        components: [],
      }).catch(() => undefined);
      return;
    }
    await replyWithSafeError(interaction);
  }
}
