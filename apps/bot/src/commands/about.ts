import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { replyWithSafeError } from '../discord/errors';
import { buildAboutEmbed } from '../info/embed';

export const aboutCommandData = new SlashCommandBuilder()
  .setName('about')
  .setDescription('Explain BrawlHub, its data sources and its limitations');

export async function handleAbout(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.reply({
      embeds: [buildAboutEmbed()],
      allowedMentions: { parse: [] },
    });
  } catch {
    await replyWithSafeError(interaction);
  }
}
