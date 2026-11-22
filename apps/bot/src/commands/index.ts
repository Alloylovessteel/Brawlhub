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
  brawlersAnchorData,
  clubsAnchorData,
  handleAnchoredComponent,
  handleBrawlersAnchor,
  handleBrawlersAnchorAutocomplete,
  handleClubsAnchor,
  handleClubsAnchorAutocomplete,
  handleHelpAnchor,
  handleMembersAnchor,
  handleMembersAnchorAutocomplete,
  handlePlayerAnchor,
  handlePlayerAnchorAutocomplete,
  helpAnchorData,
  membersAnchorData,
  playerAnchorData,
} from './option3/anchors.js';
import { resolveLegacyComponentCommand } from './option3/component-router.js';
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
  staffCommandData,
  handleStaff,
  handleStaffComponent,
} from './staff.js';
import { syncCommandData, handleSyncCommand } from './sync.js';
import { settingsCommandData, handleSettings, handleSettingsComponent } from './settings.js';
import { inactivityCommandData, handleInactivity } from './inactivity.js';
import { auditCommandData, handleAudit, handleAuditComponent } from './audit.js';
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
import {
  blacklistCommandData,
  handleBlacklist,
  handleBlacklistAutocomplete,
  handleBlacklistComponent,
} from './blacklist.js';

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
    data: clubsAnchorData,
    handle: handleClubsAnchor,
    autocomplete: handleClubsAnchorAutocomplete,
    handleComponent: handleAnchoredComponent,
  },
  {
    data: meCommandData,
    handle: handleMe,
    autocomplete: handleMeAutocomplete,
    handleComponent: handleMeComponent,
  },
  {
    data: brawlersAnchorData,
    handle: handleBrawlersAnchor,
    autocomplete: handleBrawlersAnchorAutocomplete,
    handleComponent: handleAnchoredComponent,
  },
  {
    data: playerAnchorData,
    handle: handlePlayerAnchor,
    autocomplete: handlePlayerAnchorAutocomplete,
    handleComponent: handleAnchoredComponent,
  },
  {
    data: leaderboardCommandData,
    handle: handleLeaderboard,
    handleComponent: handleLeaderboardComponent,
  },
  {
    data: eventsCommandData,
    handle: handleEvents,
    handleComponent: handleEventsComponent,
  },
  {
    data: competitionCommandData,
    handle: handleCompetition,
    autocomplete: handleCompetitionAutocomplete,
    handleComponent: handleCompetitionComponent,
  },
  {
    data: membersAnchorData,
    handle: handleMembersAnchor,
    autocomplete: handleMembersAnchorAutocomplete,
    handleComponent: handleAnchoredComponent,
  },
  {
    data: staffCommandData,
    handle: handleStaff,
    handleComponent: handleStaffComponent,
  },
  {
    data: syncCommandData,
    handle: handleSyncCommand,
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
    data: helpAnchorData,
    handle: handleHelpAnchor,
    handleComponent: handleAnchoredComponent,
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
    if (interaction.responded) return;
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
    const resolvedName = commandName === undefined ? undefined : resolveLegacyComponentCommand(commandName);
    const command =
      definitions.find((candidate) => candidate.data.name === commandName) ??
      definitions.find((candidate) => candidate.data.name === resolvedName);
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
