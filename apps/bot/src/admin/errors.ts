import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config';
import { ConfirmationError } from '../discord/confirmations';
import { StaffServiceError } from '../staff/service';
import { AdminServiceError } from './service';

async function reply(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  message: string,
): Promise<void> {
  const payload = { content: message, ephemeral: true } as const;
  if (interaction.deferred) {
    await interaction.editReply({ content: message });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

/** Send expected administration failures ephemerally; rethrow unexpected ones. */
export async function replyAdminError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
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
