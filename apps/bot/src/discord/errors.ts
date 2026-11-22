import {
  DiscordAPIError,
  MessageFlags,
  type AnySelectMenuInteraction,
  type ApplicationCommandOptionChoiceData,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

export const SAFE_USER_ERROR = 'Something went wrong. Please try again later.';

export type RepliableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | AnySelectMenuInteraction;

/** Discord interaction/message errors that are not actionable after expiry or races. */
export function isIgnorableInteractionError(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false;
  return error.code === 10062 || error.code === 40060 || error.code === 10008;
}

export interface RespondToAutocompleteOptions {
  /** Suppress unexpected response failures when already handling another error. */
  readonly swallowUnexpectedErrors?: boolean;
}

/**
 * Send autocomplete choices only while the interaction is still unacknowledged.
 * Discord acknowledgement races are ignored so handlers do not log noise when a
 * response arrives after another path already answered. Fallback callers can
 * also suppress secondary failures that would otherwise mask the original error.
 */
export async function respondToAutocomplete(
  interaction: AutocompleteInteraction,
  choices: readonly ApplicationCommandOptionChoiceData[],
  options: RespondToAutocompleteOptions = {},
): Promise<void> {
  if (interaction.responded) return;
  try {
    await interaction.respond(choices);
  } catch (error) {
    if (isIgnorableInteractionError(error) || options.swallowUnexpectedErrors === true) return;
    throw error;
  }
}

/** Sanitise an error for logs, redacting known secrets from the message. */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret !== '' && message.includes(secret)) {
      message = message.split(secret).join('[REDACTED]');
    }
  }
  return message;
}

/**
 * Send a safe, ephemeral error without leaking the underlying exception to
 * Discord. Works before and after an interaction has been deferred/replied to.
 * Interaction-expiry/acknowledgement races are ignored.
 */
export async function replyWithSafeError(interaction: RepliableInteraction): Promise<void> {
  const payload = { content: SAFE_USER_ERROR, flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  } catch (error) {
    if (isIgnorableInteractionError(error)) return;
    throw error;
  }
}

/** Autocomplete cannot send ephemeral messages; failures are logged only. */
export function logAutocompleteError(
  logger: { error: (message: string, meta?: Record<string, unknown>) => void },
  commandName: string,
  error: unknown,
  secrets: readonly string[] = [],
): void {
  logger.error('Autocomplete handler failed', {
    command: commandName,
    error: safeErrorMessage(error, secrets),
  });
}
