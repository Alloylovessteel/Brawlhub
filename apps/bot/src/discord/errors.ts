import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';

export const SAFE_USER_ERROR = 'Something went wrong. Please try again later.';

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
 */
export async function replyWithSafeError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  const payload = { content: SAFE_USER_ERROR, ephemeral: true } as const;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
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
