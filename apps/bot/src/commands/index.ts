import { createLogger } from '@brawlhub/logging';
import {
  REST,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getBotConfig } from '../config.js';
import {
  isIgnorableInteractionError,
  logAutocompleteError,
  replyWithSafeError,
  safeErrorMessage,
} from '../discord/errors.js';
import {
  clubCommandData,
  handleClub,
  handleClubAutocomplete,
  handleClubComponent,
} from './club.js';
import {
  clubsCommandData,
  handleClubs,
  handleClubsComponent,
} from './clubs.js';
import {
  clubMembersCommandData,
  handleClubMembers,
  handleClubMembersAutocomplete,
  handleClubMembersComponent,
} from './club-members.js';
import {
  clubLeaderboardCommandData,
  handleClubLeaderboard,
  handleClubLeaderboardAutocomplete,
  handleClubLeaderboardComponent,
} from './club-leaderboard.js';
import {
  clubLogCommandData,
  handleClubLog,
  handleClubLogAutocomplete,
  handleClubLogComponent,
} from './club-log.js';
import {
  clubHistoryCommandData,
  handleClubHistory,
  handleClubHistoryAutocomplete,
  handleClubHistoryComponent,
} from './club-history.js';
import {
  clubCompareCommandData,
  handleClubCompare,
  handleClubCompareAutocomplete,
} from './club-compare.js';
import {
  eventsCommandData,
  handleEvents,
  handleEventsComponent,
} from './events.js';
import {
  meCommandData,
  handleMe,
  handleMeAutocomplete,
} from './player.js';
import { handleMeComponent } from './me-components.js';
import {
  playerHistoryCommandData,
  handlePlayerHistory,
  handlePlayerHistoryAutocomplete,
  handlePlayerHistoryComponent,
} from './player-history.js';
import {
  playerBattlesCommandData,
  handlePlayerBattles,
  handlePlayerBattlesAutocomplete,
  handlePlayerBattlesComponent,
} from './player-battles.js';
import {
  brawlersCommandData,
  brawlerCommandData,
  handleBrawlers,
  handleBrawlersAutocomplete,
  handleBrawlersComponent,
  handleBrawler,
} from './brawlers.js';
import {
  playerClubsCommandData,
  handlePlayerClubs,
  handlePlayerClubsAutocomplete,
  handlePlayerClubsComponent,
} from './player-clubs.js';
import {
  playerCompareCommandData,
  handlePlayerCompare,
  handlePlayerCompareAutocomplete,
} from './player-compare.js';
import {
  leaderboardCommandData,
  handleLeaderboard,
  handleLeaderboardComponent,
} from './leaderboard.js';
import {
  handleCompetition,
  handleCompetitionAutocomplete,
  handleCompetitionComponent,
  competitionCommandData,
} from './competition.js';
import {
  membersCommandData,
  handleMembers,
  handleMembersAutocomplete,
  handleMembersComponent,
} from './members.js';
import { memberVerifyCommandData, handleMemberVerify } from './member-verify.js';
import {
  accountsCommandData,
  handleAccounts,
  handleAccountsAutocomplete,
} from './accounts.js';
import {
  verifyInfoCommandData,
  handleVerifyInfo,
  verifySettingsCommandData,
  handleVerifySettings,
} from './verification-info.js';
import {
  tagCommandData,
  handleTag,
  registerListCommandData,
  handleRegisterList,
  findCommandData,
  handleFind,
  unverifyOneCommandData,
  handleUnverifyOne,
  handleUnverifyOneComponent,
  unverifyAllCommandData,
  handleUnverifyAll,
  handleUnverifyAllComponent,
} from './admin-identity.js';
import {
  deleteMeCommandData,
  handleDeleteMe,
  handleDeleteMeComponent,
} from './delete-me.js';
import {
  memberHistoryCommandData,
  handleMemberHistory,
  handleMemberHistoryAutocomplete,
  handleMemberHistoryComponent,
} from './member-history.js';
import {
  memberSearchCommandData,
  handleMemberSearch,
  handleMemberSearchAutocomplete,
  handleMemberSearchComponent,
} from './member-search.js';
import {
  blacklistCommandData,
  handleBlacklist,
  handleBlacklistAutocomplete,
  handleBlacklistComponent,
} from './blacklist.js';
import {
  staffCommandData,
  handleStaff,
  handleStaffComponent,
} from './staff.js';
import {
  registerClubCommandData,
  handleRegisterClub,
  handleRegisterClubComponent,
} from './register-club.js';
import { syncCommandData, handleSync } from './sync.js';
import { syncStatusCommandData, handleSyncStatus } from './sync-status.js';
import { settingsCommandData, handleSettings, handleSettingsComponent } from './settings.js';
import { inactivityCommandData, handleInactivity } from './inactivity.js';
import { auditCommandData, handleAudit, handleAuditComponent } from './audit.js';
import {
  removeClubCommandData,
  handleRemoveClub,
  handleRemoveClubAutocomplete,
  handleRemoveClubComponent,
} from './remove-club.js';
import {
  viewCommandData,
  handleView,
  handleViewAutocomplete,
} from './view.js';
import {
  clubOverviewCommandData,
  handleClubOverview,
  handleClubOverviewComponent,
} from './club-overview.js';
import {
  clubLogsCommandData,
  handleClubLogs,
  handleClubLogsAutocomplete,
  handleClubLogsComponent,
} from './clublogs.js';
import { handlePing } from './ping.js';
import {
  helpCommandData,
  handleHelp,
  handleHelpComponent,
} from './help.js';
import { aboutCommandData, handleAbout } from './about.js';
import { statusCommandData, handleStatus } from './status.js';
import {
  fnCommandData,
  handleFn,
  handleFnComponent,
} from './fn.js';
import {
  autoCommandData,
  handleAuto,
  handleAutoComponent,
} from './auto.js';
import {
  updateCommandData,
  handleUpdate,
  handleUpdateComponent,
} from './update.js';
import { clubRolesCommandData, handleClubRoles } from './club-roles.js';

const logger = createLogger('bot');

function errorMessage(error: unknown): string {
  const { token } = getBotConfig();
  return safeErrorMessage(error, token === undefined ? [] : [token]);
}

export type { CommandComponentInteraction } from '../discord/interactions.js';

export interface CommandDefinition {
  readonly data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  readonly handle: (interaction: ChatInputCommandInteraction) => Promise<void>;
  readonly autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  readonly handleComponent?: (interaction: CommandComponentInteraction) => Promise<void>;
}

export const commands: readonly CommandDefinition[] = [
  {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check that BrawlHub bot is online'),
    handle: handlePing,
  },
  {
    data: clubCommandData,
    handle: handleClub,
    autocomplete: handleClubAutocomplete,
    handleComponent: handleClubComponent,
  },
  {
    data: clubsCommandData,
    handle: handleClubs,
    handleComponent: handleClubsComponent,
  },
  {
    data: clubMembersCommandData,
    handle: handleClubMembers,
    autocomplete: handleClubMembersAutocomplete,
    handleComponent: handleClubMembersComponent,
  },
  {
    data: clubLeaderboardCommandData,
    handle: handleClubLeaderboard,
    autocomplete: handleClubLeaderboardAutocomplete,
    handleComponent: handleClubLeaderboardComponent,
  },
  {
    data: clubLogCommandData,
    handle: handleClubLog,
    autocomplete: handleClubLogAutocomplete,
    handleComponent: handleClubLogComponent,
  },
  {
    data: clubHistoryCommandData,
    handle: handleClubHistory,
    autocomplete: handleClubHistoryAutocomplete,
    handleComponent: handleClubHistoryComponent,
  },
  {
    data: clubCompareCommandData,
    handle: handleClubCompare,
    autocomplete: handleClubCompareAutocomplete,
  },
  {
    data: viewCommandData,
    handle: handleView,
    autocomplete: handleViewAutocomplete,
  },
  {
    data: clubOverviewCommandData,
    handle: handleClubOverview,
    handleComponent: handleClubOverviewComponent,
  },
  {
    data: clubLogsCommandData,
    handle: handleClubLogs,
    autocomplete: handleClubLogsAutocomplete,
    handleComponent: handleClubLogsComponent,
  },
  {
    data: eventsCommandData,
    handle: handleEvents,
    handleComponent: handleEventsComponent,
  },
  {
    data: meCommandData,
    handle: handleMe,
    autocomplete: handleMeAutocomplete,
    handleComponent: handleMeComponent,
  },
  {
    data: playerHistoryCommandData,
    handle: handlePlayerHistory,
    autocomplete: handlePlayerHistoryAutocomplete,
    handleComponent: handlePlayerHistoryComponent,
  },
  {
    data: playerBattlesCommandData,
    handle: handlePlayerBattles,
    autocomplete: handlePlayerBattlesAutocomplete,
    handleComponent: handlePlayerBattlesComponent,
  },
  {
    data: brawlersCommandData,
    handle: handleBrawlers,
    autocomplete: handleBrawlersAutocomplete,
    handleComponent: handleBrawlersComponent,
  },
  {
    data: brawlerCommandData,
    handle: handleBrawler,
    autocomplete: handleBrawlersAutocomplete,
  },
  {
    data: playerClubsCommandData,
    handle: handlePlayerClubs,
    autocomplete: handlePlayerClubsAutocomplete,
    handleComponent: handlePlayerClubsComponent,
  },
  {
    data: playerCompareCommandData,
    handle: handlePlayerCompare,
    autocomplete: handlePlayerCompareAutocomplete,
  },
  {
    data: leaderboardCommandData,
    handle: handleLeaderboard,
    handleComponent: handleLeaderboardComponent,
  },
  {
    data: competitionCommandData,
    handle: handleCompetition,
    autocomplete: handleCompetitionAutocomplete,
    handleComponent: handleCompetitionComponent,
  },
  {
    data: membersCommandData,
    handle: handleMembers,
    autocomplete: handleMembersAutocomplete,
    handleComponent: handleMembersComponent,
  },
  {
    data: memberVerifyCommandData,
    handle: handleMemberVerify,
  },
  {
    data: accountsCommandData,
    handle: handleAccounts,
    autocomplete: handleAccountsAutocomplete,
  },
  {
    data: verifyInfoCommandData,
    handle: handleVerifyInfo,
  },
  {
    data: verifySettingsCommandData,
    handle: handleVerifySettings,
  },
  {
    data: tagCommandData,
    handle: handleTag,
  },
  {
    data: registerListCommandData,
    handle: handleRegisterList,
  },
  {
    data: findCommandData,
    handle: handleFind,
  },
  {
    data: unverifyOneCommandData,
    handle: handleUnverifyOne,
    handleComponent: handleUnverifyOneComponent,
  },
  {
    data: unverifyAllCommandData,
    handle: handleUnverifyAll,
    handleComponent: handleUnverifyAllComponent,
  },
  {
    data: deleteMeCommandData,
    handle: handleDeleteMe,
    handleComponent: handleDeleteMeComponent,
  },
  {
    data: memberHistoryCommandData,
    handle: handleMemberHistory,
    autocomplete: handleMemberHistoryAutocomplete,
    handleComponent: handleMemberHistoryComponent,
  },
  {
    data: memberSearchCommandData,
    handle: handleMemberSearch,
    autocomplete: handleMemberSearchAutocomplete,
    handleComponent: handleMemberSearchComponent,
  },
  {
    data: staffCommandData,
    handle: handleStaff,
    handleComponent: handleStaffComponent,
  },
  {
    data: registerClubCommandData,
    handle: handleRegisterClub,
    handleComponent: handleRegisterClubComponent,
  },
  {
    data: syncCommandData,
    handle: handleSync,
  },
  {
    data: syncStatusCommandData,
    handle: handleSyncStatus,
  },
  {
    data: settingsCommandData,
    handle: handleSettings,
    handleComponent: handleSettingsComponent,
  },
  {
    data: inactivityCommandData,
    handle: handleInactivity,
  },
  {
    data: auditCommandData,
    handle: handleAudit,
    handleComponent: handleAuditComponent,
  },
  {
    data: removeClubCommandData,
    handle: handleRemoveClub,
    autocomplete: handleRemoveClubAutocomplete,
    handleComponent: handleRemoveClubComponent,
  },
  {
    data: helpCommandData,
    handle: handleHelp,
    handleComponent: handleHelpComponent,
  },
  {
    data: aboutCommandData,
    handle: handleAbout,
  },
  {
    data: statusCommandData,
    handle: handleStatus,
  },
  {
    data: fnCommandData,
    handle: handleFn,
    handleComponent: handleFnComponent,
  },
  {
    data: autoCommandData,
    handle: handleAuto,
    handleComponent: handleAutoComponent,
  },
  {
    data: updateCommandData,
    handle: handleUpdate,
    handleComponent: handleUpdateComponent,
  },
  {
    data: clubRolesCommandData,
    handle: handleClubRoles,
  },
];

/**
 * Implemented but intentionally not registered. `blacklist` calls RPCs added by
 * 0009_moderation_blacklists.sql, which remains unapplied.
 * registerCommands() and handleInteraction() only use `commands`, so these
 * definitions are never deployed or dispatched.
 */
export const pendingCommands: readonly CommandDefinition[] = [
  {
    data: blacklistCommandData,
    handle: handleBlacklist,
    autocomplete: handleBlacklistAutocomplete,
    handleComponent: handleBlacklistComponent,
  },
];

/** Alias kept for callers that prefer the descriptive name. */
export const commandDefinitions = commands;

/**
 * Register the full command set. When DISCORD_GUILD_ID is configured, commands
 * are registered to that guild (fast updates). Otherwise global application
 * commands are registered so the bot can be invited to servers without extra
 * config (propagation may take up to about an hour).
 */
export async function registerCommands(): Promise<void> {
  const { token, clientId, guildId } = getBotConfig();

  if (clientId === undefined) {
    logger.warn(
      'Skipping slash command registration: DISCORD_CLIENT_ID must be configured'
    );
    return;
  }

  if (token === undefined) {
    logger.warn('Skipping slash command registration: DISCORD_TOKEN is not configured');
    return;
  }

  const body = commands.map((command) => command.data.toJSON());
  const rest = new REST().setToken(token);

  try {
    if (guildId !== undefined) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      logger.info(`Registered ${body.length} guild slash command(s) for ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body });
      logger.info(
        `Registered ${body.length} global application slash command(s); propagation to servers may take up to ~1 hour`
      );
    }
  } catch (error) {
    logger.error('Failed to register slash commands', { error: errorMessage(error) });
  }
}

/** Dispatch chat-input, autocomplete and component interactions to commands. */
export async function handleInteraction(interaction: Interaction): Promise<void> {
  await dispatchInteraction(interaction, commands);
}

/** Testable dispatcher that accepts an explicit command set. */
export async function dispatchInteraction(
  interaction: Interaction,
  definitions: readonly CommandDefinition[],
): Promise<void> {
  if (interaction.isAutocomplete()) {
    const command = definitions.find((candidate) => candidate.data.name === interaction.commandName);
    if (command?.autocomplete === undefined) {
      return;
    }
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      if (!isIgnorableInteractionError(error)) {
        logAutocompleteError(logger, interaction.commandName, error);
      }
    }
    return;
  }

  if (interaction.isButton() || interaction.isAnySelectMenu()) {
    const [commandName] = interaction.customId.split(':');
    const command = definitions.find((candidate) => candidate.data.name === commandName);
    if (command?.handleComponent === undefined) {
      return;
    }
    try {
      await command.handleComponent(interaction);
    } catch (error) {
      if (isIgnorableInteractionError(error)) {
        logger.warn('Component interaction expired or was already acknowledged', {
          command: commandName,
          error: errorMessage(error),
        });
      } else {
        logger.error('Component handler failed', {
          command: commandName,
          error: errorMessage(error),
        });
        await replyWithSafeError(interaction).catch(() => undefined);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = definitions.find((candidate) => candidate.data.name === interaction.commandName);
  if (command === undefined) {
    logger.warn('Received an unknown chat-input command', { command: interaction.commandName });
    return;
  }

  try {
    await command.handle(interaction);
  } catch (error) {
    if (isIgnorableInteractionError(error)) {
      logger.warn('Command interaction expired or was already acknowledged', {
        command: interaction.commandName,
        error: errorMessage(error),
      });
    } else {
      logger.error('Command handler failed', {
        command: interaction.commandName,
        error: errorMessage(error),
      });
      await replyWithSafeError(interaction).catch(() => undefined);
    }
  }
}
