import {
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { accountCommandData } from '../account.js';
import {
  accountsCommandData,
  handleAccounts,
  handleAccountsAutocomplete,
} from '../accounts.js';
import {
  findCommandData,
  handleFind,
  handleRegisterList,
  handleTag,
  handleUnverifyAll,
  handleUnverifyOne,
  unverifyAllCommandData,
  unverifyOneCommandData,
} from '../admin-identity.js';
import { deleteMeCommandData, handleDeleteMe } from '../delete-me.js';
import { handleMemberVerify } from '../member-verify.js';
import { handleSettings } from '../settings.js';
import { verifyCommandData } from '../verify.js';
import { handleVerifyInfo, handleVerifySettings } from '../verification-info.js';
import { respondToAutocomplete } from '../../discord/errors.js';
import { asLegacyAutocomplete, asLegacyChatInput } from './adapter.js';
import {
  findSourceGroup,
  groupWithSubcommands,
  subcommandFromGroup,
  subcommandFromSource,
  subcommandWithOptions,
} from './option-copy.js';

function bare(name: string, description: string): SlashCommandSubcommandBuilder {
  return new SlashCommandSubcommandBuilder().setName(name).setDescription(description);
}

async function replyUnknown(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      content: 'Unknown verification action.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* /verify                                                                     */
/* -------------------------------------------------------------------------- */

const verifyBuilder = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verify your Brawl Stars account and manage verified links');

// Player verification: tag (start), check, cancel, status. The `start`
// subcommand from the legacy account wrapper is presented as `tag`.
const accountVerifyGroup = findSourceGroup(accountCommandData, 'verify');
if (accountVerifyGroup !== undefined) {
  for (const option of accountVerifyGroup.options ?? []) {
    verifyBuilder.addSubcommand(() =>
      subcommandFromGroup(
        accountCommandData,
        'verify',
        option.name,
        option.name === 'start' ? 'tag' : option.name,
        option.description,
      ),
    );
  }
}

export const verifyAnchorData = verifyBuilder
  .addSubcommand(() =>
    subcommandFromSource(
      verifyCommandData,
      'info',
      'info',
      'Post the player verification guide in this channel',
    ),
  )
  .addSubcommand(() =>
    subcommandFromSource(
      verifyCommandData,
      'settings',
      'settings',
      'Show this server’s verification settings',
    ),
  )
  .addSubcommand(() =>
    subcommandFromSource(
      verifyCommandData,
      'list',
      'list',
      'List verified account links in this server’s clubs',
    ),
  )
  .addSubcommandGroup(() =>
    groupWithSubcommands(findCommandData, 'find', 'Find verified account links'),
  )
  .addSubcommandGroup(() =>
    groupWithSubcommands(
      unverifyOneCommandData,
      'unverify-one',
      'Revoke a verified account link',
    ),
  )
  .addSubcommand(() =>
    subcommandWithOptions(unverifyAllCommandData, 'unverify-all', 'Revoke all links for a user'),
  )
  .addSubcommand(() => bare('delete-me', 'Permanently delete your BrawlHub identity data'))
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-verified-role')
      .setDescription('Set the guild verified-member role')
      .addRoleOption((option) =>
        option
          .setName('role')
          .setDescription('Role assigned to verified BrawlHub members')
          .setRequired(true),
      ),
  )
  .addSubcommand(() =>
    bare('clear-verified-role', 'Clear the guild verified-member role'),
  )
  .addSubcommandGroup((group) => {
    group.setName('accounts').setDescription('Manage your linked Brawl Stars accounts');
    group.addSubcommand(() => subcommandFromSource(accountsCommandData, 'list', 'list', 'List your linked accounts'));
    group.addSubcommand(() =>
      subcommandFromSource(
        accountsCommandData,
        'set-main',
        'set-main',
        'Choose your main account',
      ),
    );
    return group;
  });

const playerVerificationRoutes: Readonly<Record<string, string>> = {
  tag: 'start',
  check: 'check',
  cancel: 'cancel',
  status: 'status',
  start: 'start',
  'verify-start': 'start',
  'verify-check': 'check',
  'verify-cancel': 'cancel',
  'verify-status': 'status',
};

export async function handleVerifyAnchor(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand !== null) {
    const playerRoute = playerVerificationRoutes[subcommand];
    if (playerRoute !== undefined) {
      await handleMemberVerify(
        asLegacyChatInput(interaction, { group: 'verify', subcommand: playerRoute }),
      );
      return;
    }
  }

  if (group === 'find') {
    await handleFind(asLegacyChatInput(interaction, { group: 'find', subcommand }));
    return;
  }

  if (group === 'unverify-one') {
    await handleUnverifyOne(asLegacyChatInput(interaction, { group: null, subcommand }));
    return;
  }

  if (group === 'accounts') {
    await handleAccounts(asLegacyChatInput(interaction, { group: null, subcommand }));
    return;
  }

  switch (subcommand) {
    case 'info':
      await handleVerifyInfo(interaction);
      return;
    case 'settings':
      await handleVerifySettings(interaction);
      return;
    case 'list':
      await handleRegisterList(interaction);
      return;
    case 'unverify-all':
      await handleUnverifyAll(asLegacyChatInput(interaction, { subcommand: 'unverify-all' }));
      return;
    case 'delete-me':
      await handleDeleteMe(asLegacyChatInput(interaction, { subcommand: 'delete-me' }));
      return;
    case 'set-verified-role':
      await handleSettings(
        asLegacyChatInput(interaction, { group: null, subcommand: 'set-verified-role' }),
      );
      return;
    case 'clear-verified-role':
      await handleSettings(
        asLegacyChatInput(interaction, { group: null, subcommand: 'clear-verified-role' }),
      );
      return;
    default:
      await replyUnknown(interaction);
  }
}

export async function handleVerifyAnchorAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (group === 'accounts' && subcommand === 'set-main') {
    await handleAccountsAutocomplete(asLegacyAutocomplete(interaction, 'set-main'));
    return;
  }

  await respondToAutocomplete(interaction, []);
}

/* -------------------------------------------------------------------------- */
/* /tag-set                                                                    */
/* -------------------------------------------------------------------------- */

export const tagSetCommandData = new SlashCommandBuilder()
  .setName('tag-set')
  .setDescription('Link a Discord user to a Brawl Stars player as fully verified')
  .addUserOption((option) =>
    option.setName('user').setDescription('The Discord user').setRequired(true),
  )
  .addStringOption((option) =>
    option.setName('tag').setDescription('Brawl Stars player tag').setRequired(true),
  )
  .addStringOption((option) =>
    option.setName('reason').setDescription('Optional staff reason').setRequired(false),
  );

export async function handleTagSet(interaction: ChatInputCommandInteraction): Promise<void> {
  await handleTag(asLegacyChatInput(interaction, { group: 'tag', subcommand: 'set' }));
}
