import { createLogger } from '@brawlhub/logging';
import type { ChatInputCommandInteraction } from 'discord.js';

const logger = createLogger('bot');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Handle the `ping` chat-input command with an ephemeral latency reply. */
export async function handlePing(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const sent = Date.now();
    await interaction.reply({ content: 'Pong! Measuring latency…', flags: 64 });
    const roundTripMs = Date.now() - sent;
    const wsPing = Math.round(interaction.client.ws.ping);
    const wsText = Number.isFinite(wsPing) && wsPing >= 0 ? `${wsPing}ms` : 'unavailable';
    await interaction.editReply(`Pong! Round-trip: ${roundTripMs}ms • WebSocket: ${wsText}`);
  } catch (error) {
    logger.error('Failed to reply to ping command', { error: errorMessage(error) });
  }
}
