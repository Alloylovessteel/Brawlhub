import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { handleAbout } from './about.js';
import { handleStatus } from './status.js';

export const infoCommandData = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Show BrawlHub information and operational status')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('about')
      .setDescription('Explain BrawlHub, its data sources and its limitations'),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('status').setDescription('Show safe public operational status for BrawlHub'),
  );

export async function handleInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.options.getSubcommand(false)) {
    case 'about':
      await handleAbout(interaction);
      return;
    case 'status':
      await handleStatus(interaction);
      return;
    default:
      await interaction.reply({
        content: 'Unknown information action.',
        flags: MessageFlags.Ephemeral,
      });
  }
}
