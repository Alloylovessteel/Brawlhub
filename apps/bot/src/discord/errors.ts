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

/** Visible autocomplete choice used when a lookup fails instead of showing no choices. */
export const LOOKUP_UNAVAILABLE_AUTOCOMPLETE_CHOICE = {
  name: 'Lookup unavailable — try again shortly',
  value: '__lookup_unavailable__',
} as const;

/** Respond with one explicit choice so a failed autocomplete lookup is not silent. */
export async function respondWithLookupUnavailableChoice(
  interaction: AutocompleteInteraction,
): Promise<void> {
  await respondToAutocomplete(interaction, [LOOKUP_UNAVAILABLE_AUTOCOMPLETE_CHOICE], {
    swallowUnexpectedErrors: true,
  });
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

/** Standard message for a component whose prefix has no live handler. */
export const UNKNOWN_COMPONENT_MESSAGE =
  'That button or menu is no longer available. Run the command again.';

/**
 * Send explicit, ephemeral feedback from a component interaction. Works both
 * before acknowledgement and after `deferReply`/`deferUpdate`; components that
 * cannot be answered (for example a stripped-down test double) are ignored.
 */
async function replyComponentFeedback(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  const candidate = interaction as RepliableInteraction & {
    reply?: unknown;
    followUp?: unknown;
  };
  if (typeof candidate.reply !== 'function' && typeof candidate.followUp !== 'function') return;

  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  } as const;
  try {
    if (interaction.replied || interaction.deferred) {
      if (typeof candidate.followUp === 'function') {
        await candidate.followUp(payload);
      }
      return;
    }
    if (typeof candidate.reply === 'function') {
      await candidate.reply(payload);
    }
  } catch {
    // Feedback is best-effort: never mask the original handler flow.
  }
}

/** Tell the user that an embedded command state (guild/channel/session) expired. */
export async function replyExpiredComponent(
  interaction: RepliableInteraction,
  message: string,
): Promise<void> {
  await replyComponentFeedback(interaction, message);
}

/** Tell the user that a custom-ID prefix has no live handler instead of silently returning. */
export async function replyUnknownComponent(interaction: RepliableInteraction): Promise<void> {
  await replyComponentFeedback(interaction, UNKNOWN_COMPONENT_MESSAGE);
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

/**
 * Discord errors that prove a message was not created. Timeouts, rate limits
 * and network failures remain ambiguous: the request may have reached Discord
 * even though the caller saw an error, so claims must stay in place for those.
 */
export function isDefinitiveDiscordRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  const status = candidate['status'];
  const code = candidate['code'];
  const normalizedCode = typeof code === 'number' ? code : Number(code);

  if (status === 400 || status === 401 || status === 403 || status === 404) return true;
  if (
    Number.isFinite(normalizedCode) &&
    [50001, 50004, 50013, 50035].includes(normalizedCode)
  ) {
    return true;
  }

  const message = candidate['message'];
  return (
    typeof message === 'string' &&
    ['Missing Access', 'Missing Permissions', 'Cannot send messages to this channel'].includes(
      message,
    )
  );
}
