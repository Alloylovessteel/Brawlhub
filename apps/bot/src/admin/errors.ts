import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { ConfirmationError } from '../discord/confirmations';
import { AdminServiceError } from './service';

async function reply(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  message: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content: message, ephemeral: true });
    return;
  }
  await interaction.reply({ content: message, ephemeral: true });
}

/** Send expected administration failures ephemerally; rethrow unexpected ones. */
export async function replyAdminError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
  if (error instanceof AdminServiceError || error instanceof ConfirmationError) {
    await reply(interaction, error.message);
    return;
  }
  throw error;
}
