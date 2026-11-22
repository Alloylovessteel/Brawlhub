import { createLogger } from '@brawlhub/logging';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  startLiveTracking,
  stopLiveTracking,
  type LiveTrackingStartResult,
  type LiveTrackingStopResult,
} from '../live/service.js';
import { replyWithSafeError } from '../discord/errors.js';
import { cleanTag } from '../discord/format.js';
import { meTagErrorMessage, resolveMeTag } from './me-utils.js';

const logger = createLogger('bot');

function startFailureMessage(result: Exclude<LiveTrackingStartResult, { readonly kind: 'ok' }>): string {
  switch (result.kind) {
    case 'guild-required':
      return 'Live tracking is only available in a server.';
    case 'invalid-tag':
      return 'That player tag is not valid.';
    case 'not-found':
      return `Player #${result.tag} is not available in this server's stored data.`;
    case 'lookup-error':
      return 'Could not start live tracking right now. Please try again shortly.';
  }
}

function stopFailureMessage(result: Exclude<LiveTrackingStopResult, { readonly kind: 'ok' }>): string {
  switch (result.kind) {
    case 'guild-required':
      return 'Live tracking is only available in a server.';
    case 'not-found':
      return `Player #${result.tag} is not available in this server's stored data.`;
    case 'lookup-error':
      return 'Could not stop live tracking right now. Please try again shortly.';
  }
}

/** Opt the current guild/channel/user into live battle delivery for one player. */
export async function handleMeLive(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  const resolved = await resolveMeTag(interaction, 'profile');
  if (resolved.kind !== 'ok') {
    await interaction.editReply({
      content: meTagErrorMessage(resolved, 'profile'),
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    const result = await startLiveTracking({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      discordUserId: interaction.user.id,
      tag: resolved.tag,
    });
    if (result.kind !== 'ok') {
      await interaction.editReply({
        content: startFailureMessage(result),
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({
      content:
        `Live tracking enabled for \`#${cleanTag(result.playerTag)}\` in this channel. ` +
        'New official battle-log entries will be posted here. The session ends after 3 hours ' +
        'or 60 minutes without a new battle.',
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Failed to enable /me live', {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyWithSafeError(interaction);
  }
}

/** Stop live battle delivery in this channel for the current user. */
export async function handleMeLiveStop(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  try {
    const result = await stopLiveTracking({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      discordUserId: interaction.user.id,
    });
    if (result.kind !== 'ok') {
      await interaction.editReply({
        content: stopFailureMessage(result),
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({
      content:
        result.stopped === 0
          ? 'You had no active live tracking in this channel.'
          : `Live tracking stopped for ${result.stopped} subscription(s) in this channel.`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Failed to stop /me live', {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyWithSafeError(interaction);
  }
}
