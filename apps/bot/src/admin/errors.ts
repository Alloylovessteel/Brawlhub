import { MessageFlags } from 'discord.js';
import { getBotConfig } from '../config';
import { ConfirmationError } from '../discord/confirmations';
import { isIgnorableInteractionError, type RepliableInteraction } from '../discord/errors.js';
import { StaffServiceError } from '../staff/service';
import { AdminServiceError } from './service';

async function reply(interaction: RepliableInteraction, message: string): Promise<void> {
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  } catch (error) {
    if (isIgnorableInteractionError(error)) return;
    throw error;
  }
}

/** Send expected administration failures ephemerally; rethrow unexpected ones. */
export async function replyAdminError(
  interaction: RepliableInteraction,
  error: unknown,
): Promise<void> {
  if (isIgnorableInteractionError(error)) return;
  if (
    error instanceof AdminServiceError ||
    error instanceof ConfirmationError ||
    error instanceof StaffServiceError
  ) {
    let message = error.message;
    if (error instanceof StaffServiceError && error.code === 'profile_not_linked') {
      const appUrl = getBotConfig().appUrl;
      if (appUrl !== undefined && !message.includes(appUrl)) {
        message = `${message} ${appUrl}`.trim();
      }
    }
    await reply(interaction, message);
    return;
  }
  throw error;
}
