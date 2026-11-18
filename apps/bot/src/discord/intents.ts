import { GatewayIntentBits } from 'discord.js';

/**
 * Gateway intents required by the bot.
 *
 * - `Guilds` provides guild and role create/update/delete events.
 * - `GuildMembers` is privileged and is required for member update events and
 *   REST member-list access.
 *
 * No presence, message-content, or other privileged intents are needed.
 */
export function getGatewayIntents(): GatewayIntentBits[] {
  return [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
}
