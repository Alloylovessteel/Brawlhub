import {
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  clubCommandData,
  handleClub,
  handleClubAutocomplete,
} from '../club.js';
import { handleClubs } from '../clubs.js';
import {
  clubMembersCommandData,
  handleClubMembers,
  handleClubMembersAutocomplete,
} from '../club-members.js';
import {
  clubLeaderboardCommandData,
  handleClubLeaderboard,
  handleClubLeaderboardAutocomplete,
} from '../club-leaderboard.js';
import {
  clubLogCommandData,
  handleClubLog,
  handleClubLogAutocomplete,
} from '../club-log.js';
import {
  clubHistoryCommandData,
  handleClubHistory,
  handleClubHistoryAutocomplete,
} from '../club-history.js';
import {
  clubCompareCommandData,
  handleClubCompare,
  handleClubCompareAutocomplete,
} from '../club-compare.js';
import {
  viewCommandData,
  handleView,
  handleViewAutocomplete,
} from '../view.js';
import { clubOverviewCommandData, handleClubOverview } from '../club-overview.js';
import {
  clubLogsCommandData,
  handleClubLogs,
  handleClubLogsAutocomplete,
} from '../clublogs.js';
import {
  registerClubCommandData,
  handleRegisterClub,
} from '../register-club.js';
import {
  removeClubCommandData,
  handleRemoveClub,
  handleRemoveClubAutocomplete,
} from '../remove-club.js';
import {
  playerHistoryCommandData,
  handlePlayerHistory,
  handlePlayerHistoryAutocomplete,
} from '../player-history.js';
import {
  playerBattlesCommandData,
  handlePlayerBattles,
  handlePlayerBattlesAutocomplete,
} from '../player-battles.js';
import {
  brawlersCommandData,
  brawlerCommandData,
  handleBrawlers,
  handleBrawlersAutocomplete,
  handleBrawler,
} from '../brawlers.js';
import {
  playerClubsCommandData,
  handlePlayerClubs,
  handlePlayerClubsAutocomplete,
} from '../player-clubs.js';
import {
  playerCompareCommandData,
  handlePlayerCompare,
  handlePlayerCompareAutocomplete,
} from '../player-compare.js';
import {
  membersCommandData,
  handleMembers,
  handleMembersAutocomplete,
} from '../members.js';
import {
  memberHistoryCommandData,
  handleMemberHistory,
  handleMemberHistoryAutocomplete,
} from '../member-history.js';
import {
  memberSearchCommandData,
  handleMemberSearch,
  handleMemberSearchAutocomplete,
} from '../member-search.js';
import { helpCommandData, handleHelp } from '../help.js';
import { infoCommandData, handleInfo } from '../info.js';
import { handlePing } from '../ping.js';
import {
  groupWithSubcommands,
  subcommandFromSource,
  subcommandWithOptions,
} from './option-copy.js';
import { handleCompositeComponent } from './component-router.js';
import { respondToAutocomplete } from '../../discord/errors.js';
import { asLegacyAutocomplete, asLegacyChatInput } from './adapter.js';

function bare(name: string, description: string): SlashCommandSubcommandBuilder {
  return new SlashCommandSubcommandBuilder().setName(name).setDescription(description);
}

async function replyUnknown(
  interaction: ChatInputCommandInteraction,
  command: string,
): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      content: `Unknown ${command} action.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* /clubs                                                                      */
/* -------------------------------------------------------------------------- */

export const clubsAnchorData = new SlashCommandBuilder()
  .setName('clubs')
  .setDescription('Club overview, details, members, logs, history and overview configuration')
  .addSubcommand(() =>
    subcommandWithOptions(clubCommandData, 'details', 'Show club info and member details'),
  )
  .addSubcommand(() => bare('overview', 'Show the server’s registered club overview'))
  .addSubcommand(() =>
    subcommandWithOptions(clubMembersCommandData, 'members', 'Show tracked club members'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(clubLeaderboardCommandData, 'leaderboard', 'Show a club leaderboard'),
  )
  .addSubcommand(() => subcommandWithOptions(clubLogCommandData, 'log', 'Show club activity logs'))
  .addSubcommand(() =>
    subcommandWithOptions(clubHistoryCommandData, 'history', 'Show club trophy history'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(clubCompareCommandData, 'compare', 'Compare two clubs'),
  )
  .addSubcommandGroup(() =>
    groupWithSubcommands(viewCommandData, 'view', 'Choose clubs shown in the server overview'),
  )
  .addSubcommand(() =>
    bare('fields', 'Choose which details appear in the server club overview'),
  )
  .addSubcommandGroup(() =>
    groupWithSubcommands(clubLogsCommandData, 'clublogs', 'Configure scheduled club log reports'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(registerClubCommandData, 'register', 'Register a club in this server'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(removeClubCommandData, 'remove', 'Archive a registered club'),
  );

export async function handleClubsAnchor(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (group === 'view') {
    await handleView(asLegacyChatInput(interaction, { group: null, subcommand }));
    return;
  }
  if (group === 'clublogs' || group === 'logs') {
    await handleClubLogs(asLegacyChatInput(interaction, { group: null, subcommand }));
    return;
  }

  switch (subcommand) {
    case 'details':
      await handleClub(asLegacyChatInput(interaction, { group: null, subcommand: 'details' }));
      return;
    case 'overview':
      await handleClubs(asLegacyChatInput(interaction, { group: null, subcommand: null }));
      return;
    case 'members':
      await handleClubMembers(asLegacyChatInput(interaction, { group: null, subcommand: 'members' }));
      return;
    case 'leaderboard':
      await handleClubLeaderboard(
        asLegacyChatInput(interaction, { group: null, subcommand: 'leaderboard' }),
      );
      return;
    case 'log':
      await handleClubLog(asLegacyChatInput(interaction, { group: null, subcommand: 'log' }));
      return;
    case 'history':
      await handleClubHistory(asLegacyChatInput(interaction, { group: null, subcommand: 'history' }));
      return;
    case 'compare':
      await handleClubCompare(asLegacyChatInput(interaction, { group: null, subcommand: 'compare' }));
      return;
    case 'fields':
      await handleClubOverview(asLegacyChatInput(interaction, { group: null, subcommand: 'menu' }));
      return;
    case 'register':
      await handleRegisterClub(asLegacyChatInput(interaction, { group: null, subcommand: 'register' }));
      return;
    case 'remove':
      await handleRemoveClub(asLegacyChatInput(interaction, { group: null, subcommand: 'remove' }));
      return;
    default:
      await replyUnknown(interaction, '/clubs');
  }
}

export async function handleClubsAnchorAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (group === 'view') {
    await handleViewAutocomplete(asLegacyAutocomplete(interaction, subcommand));
    return;
  }
  if (group === 'clublogs' || group === 'logs') {
    await handleClubLogsAutocomplete(asLegacyAutocomplete(interaction, subcommand));
    return;
  }

  switch (subcommand) {
    case 'details':
      await handleClubAutocomplete(asLegacyAutocomplete(interaction, 'details'));
      return;
    case 'members':
      await handleClubMembersAutocomplete(asLegacyAutocomplete(interaction, 'members'));
      return;
    case 'leaderboard':
      await handleClubLeaderboardAutocomplete(asLegacyAutocomplete(interaction, 'leaderboard'));
      return;
    case 'log':
      await handleClubLogAutocomplete(asLegacyAutocomplete(interaction, 'log'));
      return;
    case 'history':
      await handleClubHistoryAutocomplete(asLegacyAutocomplete(interaction, 'history'));
      return;
    case 'compare':
      await handleClubCompareAutocomplete(
        asLegacyAutocomplete(interaction, 'compare'),
      );
      return;
    case 'remove':
      await handleRemoveClubAutocomplete(
        asLegacyAutocomplete(interaction, 'remove'),
      );
      return;
    default:
      await respondToAutocomplete(interaction, []);
  }
}

/* -------------------------------------------------------------------------- */
/* /player                                                                     */
/* -------------------------------------------------------------------------- */

export const playerAnchorData = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Player history, battles, clubs and comparisons')
  .addSubcommand(() =>
    subcommandWithOptions(playerHistoryCommandData, 'history', 'Show player trophy history'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(playerBattlesCommandData, 'battles', 'Show recent player battles'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(playerClubsCommandData, 'clubs', 'Show a player’s club history'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(playerCompareCommandData, 'compare', 'Compare two players'),
  );

export async function handlePlayerAnchor(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  switch (subcommand) {
    case 'history':
      await handlePlayerHistory(asLegacyChatInput(interaction, { subcommand: 'history' }));
      return;
    case 'battles':
      await handlePlayerBattles(asLegacyChatInput(interaction, { subcommand: 'battles' }));
      return;
    case 'clubs':
      await handlePlayerClubs(asLegacyChatInput(interaction, { subcommand: 'clubs' }));
      return;
    case 'compare':
      await handlePlayerCompare(asLegacyChatInput(interaction, { subcommand: 'compare' }));
      return;
    default:
      await replyUnknown(interaction, '/player');
  }
}

export async function handlePlayerAnchorAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  switch (subcommand) {
    case 'history':
      await handlePlayerHistoryAutocomplete(asLegacyAutocomplete(interaction, 'history'));
      return;
    case 'battles':
      await handlePlayerBattlesAutocomplete(asLegacyAutocomplete(interaction, 'battles'));
      return;
    case 'clubs':
      await handlePlayerClubsAutocomplete(asLegacyAutocomplete(interaction, 'clubs'));
      return;
    case 'compare':
      await handlePlayerCompareAutocomplete(interaction);
      return;
    default:
      await respondToAutocomplete(interaction, []);
  }
}

/* -------------------------------------------------------------------------- */
/* /brawlers                                                                   */
/* -------------------------------------------------------------------------- */

export const brawlersAnchorData = new SlashCommandBuilder()
  .setName('brawlers')
  .setDescription('Browse brawler statistics and details')
  .addSubcommand(() =>
    subcommandWithOptions(brawlersCommandData, 'list', 'List brawler statistics'),
  )
  .addSubcommand(() =>
    subcommandWithOptions(brawlerCommandData, 'detail', 'Show full details for one brawler'),
  );

export async function handleBrawlersAnchor(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand === 'detail') {
    await handleBrawler(asLegacyChatInput(interaction, { subcommand: 'detail' }));
    return;
  }
  if (subcommand === 'list') {
    await handleBrawlers(asLegacyChatInput(interaction, { subcommand: 'list' }));
    return;
  }
  await replyUnknown(interaction, '/brawlers');
}

export async function handleBrawlersAnchorAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand === 'detail' || subcommand === 'list') {
    await handleBrawlersAutocomplete(asLegacyAutocomplete(interaction, subcommand));
    return;
  }
  await respondToAutocomplete(interaction, []);
}

/* -------------------------------------------------------------------------- */
/* /members                                                                    */
/* -------------------------------------------------------------------------- */

export const membersAnchorData = new SlashCommandBuilder()
  .setName('members')
  .setDescription('Tracked members and verified-member searches')
  .addSubcommand(() =>
    subcommandWithOptions(membersCommandData, 'roster', 'Show tracked members in a club'),
  )
  .addSubcommandGroup((group) => {
    group.setName('find').setDescription('Find verified members in this server');
    group.addSubcommand(() =>
      subcommandFromSource(
        memberSearchCommandData,
        'player',
        'player',
        'Search verified members by player tag or name',
      ),
    );
    group.addSubcommand(() =>
      subcommandFromSource(
        memberSearchCommandData,
        'discord',
        'discord',
        'Search verified members by Discord user',
      ),
    );
    return group;
  })
  .addSubcommand(() =>
    subcommandWithOptions(memberHistoryCommandData, 'history', 'Show a member’s club history'),
  );

export async function handleMembersAnchor(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (group === 'find' || group === 'search') {
    await handleMemberSearch(asLegacyChatInput(interaction, { group: null, subcommand }));
    return;
  }

  switch (subcommand) {
    case 'roster':
      await handleMembers(asLegacyChatInput(interaction, { subcommand: 'roster' }));
      return;
    case 'history':
      await handleMemberHistory(asLegacyChatInput(interaction, { subcommand: 'history' }));
      return;
    default:
      await replyUnknown(interaction, '/members');
  }
}

export async function handleMembersAnchorAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);

  if (group === 'find' || group === 'search') {
    if (subcommand === 'player') {
      await handleMemberSearchAutocomplete(asLegacyAutocomplete(interaction, 'player'));
      return;
    }
    await respondToAutocomplete(interaction, []);
    return;
  }

  switch (subcommand) {
    case 'roster':
      await handleMembersAutocomplete(asLegacyAutocomplete(interaction, 'roster'));
      return;
    case 'history':
      await handleMemberHistoryAutocomplete(asLegacyAutocomplete(interaction, 'history'));
      return;
    default:
      await respondToAutocomplete(interaction, []);
  }
}

/* -------------------------------------------------------------------------- */
/* /help                                                                       */
/* -------------------------------------------------------------------------- */

export const helpAnchorData = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Command directory, information and connectivity checks')
  .addSubcommand(() => bare('directory', 'List the available commands'))
  .addSubcommand(() => bare('about', 'Explain BrawlHub, its sources and limitations'))
  .addSubcommand(() => bare('status', 'Show safe public operational status'))
  .addSubcommand(() => bare('ping', 'Check that the bot is online'));

export async function handleHelpAnchor(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  switch (subcommand) {
    case 'directory':
      await handleHelp(asLegacyChatInput(interaction, { subcommand: null }));
      return;
    case 'about':
    case 'status':
      await handleInfo(asLegacyChatInput(interaction, { subcommand }));
      return;
    case 'ping':
      await handlePing(asLegacyChatInput(interaction, { subcommand: null }));
      return;
    default:
      await replyUnknown(interaction, '/help');
  }
}

export { handleCompositeComponent as handleAnchoredComponent };
