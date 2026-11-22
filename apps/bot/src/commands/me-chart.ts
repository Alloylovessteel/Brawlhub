import { createLogger } from '@brawlhub/logging';
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { replyWithSafeError } from '../discord/errors.js';
import { cleanTag } from '../discord/format.js';
import {
  chartFailureMessage,
  loadOrRenderChart,
} from '../images/chart-service.js';
import type { ChartOption } from '../images/chart-render.js';
import { meTagErrorMessage, resolveMeTag } from './me-utils.js';
import { isPlayerHistoryPeriod, DEFAULT_PLAYER_PERIOD } from './player-utils.js';

const logger = createLogger('bot');

/** Post a public PNG chart built only from stored player snapshots/battles. */
export async function handleMeChart(
  interaction: ChatInputCommandInteraction,
  option: ChartOption,
): Promise<void> {
  await interaction.deferReply();

  const resolved = await resolveMeTag(interaction, 'profile');
  if (resolved.kind !== 'ok') {
    await interaction.editReply({
      content: meTagErrorMessage(resolved, 'profile'),
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (interaction.guildId === null) {
    await interaction.editReply({
      content: '`/me chart` is only available in a server.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const rawPeriod = interaction.options.getString('period', false);
  const period = rawPeriod !== null && isPlayerHistoryPeriod(rawPeriod)
    ? rawPeriod
    : DEFAULT_PLAYER_PERIOD;

  try {
    const result = await loadOrRenderChart({
      guildId: interaction.guildId,
      kind: 'player',
      tag: resolved.tag,
      option,
      period,
    });
    if (result.kind === 'failure') {
      await interaction.editReply({
        content: chartFailureMessage(result.failure),
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({
      content: `Stored chart for \`#${cleanTag(resolved.tag)}\` · ${option.replaceAll('_', ' ')}`,
      files: [new AttachmentBuilder(result.image.png, { name: result.image.fileName })],
      // Images are public in the channel and never carry components.
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Failed to build /me chart', {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyWithSafeError(interaction);
  }
}
