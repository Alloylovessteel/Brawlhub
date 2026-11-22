import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { respondToAutocomplete } from '../discord/errors.js';
import { handleAccounts, handleAccountsAutocomplete } from './accounts.js';
import { handleMemberVerify } from './member-verify.js';

export const accountCommandData = new SlashCommandBuilder()
  .setName('account')
  .setDescription('Manage your linked Brawl Stars accounts and player verification')
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List your linked accounts, main and alts'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-main')
      .setDescription('Choose which linked account is your main')
      .addStringOption((option) =>
        option
          .setName('tag')
          .setDescription('The linked account to make main')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('verify')
      .setDescription('Verify ownership of a Brawl Stars player')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('start')
          .setDescription('Start verification and get a random required default brawler icon')
          .addStringOption((option) =>
            option
              .setName('tag')
              .setDescription('Your Brawl Stars player tag (e.g. #2ABC)')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('check')
          .setDescription('Check whether your in-game icon matches the required icon shown at start'),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName('cancel').setDescription('Cancel your active verification challenge'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('status')
          .setDescription('Show your active verification challenge and the required icon'),
      ),
  );

export async function handleAccount(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommandGroup(false) === 'verify') {
    await handleMemberVerify(interaction);
    return;
  }
  await handleAccounts(interaction);
}

export async function handleAccountAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.options.getSubcommand(false) === 'set-main') {
    await handleAccountsAutocomplete(interaction);
    return;
  }
  await respondToAutocomplete(interaction, []);
}
