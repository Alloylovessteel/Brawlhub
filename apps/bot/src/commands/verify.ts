import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { handleFind, handleRegisterList, handleTag } from './admin-identity.js';
import { handleVerifyInfo, handleVerifySettings } from './verification-info.js';

export const verifyCommandData = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Manage player verification and verified account links')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('info')
      .setDescription('Post the BrawlHub player verification guide in this channel'),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('settings').setDescription('Show this server’s verification settings'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List verified account links for players in this server’s clubs'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('tag')
      .setDescription('Manage staff-forced account links')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('Link a Discord user to a Brawl Stars player (fully verified)')
          .addUserOption((option) =>
            option.setName('user').setDescription('The Discord user').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('tag').setDescription('Brawl Stars player tag').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Optional staff reason').setRequired(false),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('find')
      .setDescription('Find a verified account link in this server')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('user')
          .setDescription('Find links for a Discord user')
          .addUserOption((option) =>
            option.setName('user').setDescription('Discord user').setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('tag')
          .setDescription('Find links for a Brawl Stars player tag')
          .addStringOption((option) =>
            option.setName('tag').setDescription('Player tag').setRequired(true),
          ),
      ),
  );

export async function handleVerify(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  if (group === 'tag') {
    await handleTag(interaction);
    return;
  }
  if (group === 'find') {
    await handleFind(interaction);
    return;
  }

  switch (interaction.options.getSubcommand(false)) {
    case 'info':
      await handleVerifyInfo(interaction);
      return;
    case 'settings':
      await handleVerifySettings(interaction);
      return;
    case 'list':
      await handleRegisterList(interaction);
      return;
    default:
      await interaction.reply({
        content: 'Unknown verification action.',
        flags: MessageFlags.Ephemeral,
      });
  }
}
