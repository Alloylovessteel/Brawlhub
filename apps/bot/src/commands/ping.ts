import { createLogger } from '@brawlhub/logging';
import type { ChatInputCommandInteraction } from 'discord.js';

const logger = createLogger('bot');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Handle the `ping` chat-input command with an ephemeral "Pong!" reply. */
export async function handlePing(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.reply({ content: 'Pong!', ephemeral: true });
  } catch (error) {
    logger.error('Failed to reply to ping command', { error: errorMessage(error) });
  }
}
