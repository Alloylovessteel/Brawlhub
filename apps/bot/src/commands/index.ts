import { createLogger } from '@brawlhub/logging';
import {
  REST,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { getBotConfig } from '../config.js';
import {
  logAutocompleteError,
  replyWithSafeError,
  safeErrorMessage,
} from '../discord/errors.js';
import { handlePing } from './ping.js';

const logger = createLogger('bot');

function errorMessage(error: unknown): string {
  const { token } = getBotConfig();
  return safeErrorMessage(error, token === undefined ? [] : [token]);
}

export interface CommandDefinition {
  readonly data: SlashCommandBuilder;
  readonly handle: (interaction: ChatInputCommandInteraction) => Promise<void>;
  readonly autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  readonly handleComponent?: (interaction: ButtonInteraction) => Promise<void>;
}

export const commands: readonly CommandDefinition[] = [
  {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check that BrawlHub bot is online'),
    handle: handlePing,
  },
];

/** Alias kept for callers that prefer the descriptive name. */
export const commandDefinitions = commands;

/**
 * Register the full command set as guild commands. PUT is idempotent: it is safe
 * to call on every startup. Global registration is never attempted.
 */
export async function registerCommands(): Promise<void> {
  const { token, clientId, guildId } = getBotConfig();

  if (clientId === undefined || guildId === undefined) {
    logger.warn(
      'Skipping slash command registration: DISCORD_CLIENT_ID and DISCORD_GUILD_ID must both be configured (no global registration attempted)'
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
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    logger.info(`Registered ${body.length} guild slash command(s)`);
  } catch (error) {
    logger.error('Failed to register guild slash commands', { error: errorMessage(error) });
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
      logAutocompleteError(logger, interaction.commandName, error);
    }
    return;
  }

  if (interaction.isButton()) {
    const [commandName] = interaction.customId.split(':');
    const command = definitions.find((candidate) => candidate.data.name === commandName);
    if (command?.handleComponent === undefined) {
      return;
    }
    try {
      await command.handleComponent(interaction);
    } catch (error) {
      logger.error('Component handler failed', {
        command: commandName,
        error: errorMessage(error),
      });
      await replyWithSafeError(interaction).catch(() => undefined);
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
    logger.error('Command handler failed', {
      command: interaction.commandName,
      error: errorMessage(error),
    });
    await replyWithSafeError(interaction).catch(() => undefined);
  }
}
