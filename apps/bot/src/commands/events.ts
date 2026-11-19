import { createLogger } from '@brawlhub/logging';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getBotConfig } from '../config.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { replyWithSafeError, safeErrorMessage } from '../discord/errors.js';
import {
  buildPaginationRowWithState,
  parsePaginationCustomIdWithState,
} from '../discord/pagination.js';
import { buildEventPageEmbed, paginateEvents } from '../events/embed.js';
import { loadEventView } from '../events/service.js';
import type { EventKind } from '../events/types.js';

const logger = createLogger('bot');
const COMMAND_NAME = 'events';

export const eventsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show the live Brawl Stars event rotation')
  .addSubcommand((subcommand) =>
    subcommand.setName('active').setDescription('Show events running right now'),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('upcoming').setDescription('Show events starting soon'),
  );

function resolveKind(interaction: ChatInputCommandInteraction): EventKind {
  return interaction.options.getSubcommand(false) === 'upcoming' ? 'upcoming' : 'active';
}

async function buildPage(kind: EventKind, pageNumber: number) {
  const view = await loadEventView(kind);
  const page = paginateEvents(view, pageNumber);
  const embed = buildEventPageEmbed(view, page);
  const row = buildPaginationRowWithState(COMMAND_NAME, page.page, page.pageCount, kind);
  return { embeds: [embed], components: row === null ? [] : [row] };
}

/** `/events active|upcoming` — official live rotation with optional static assets. */
export async function handleEvents(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply();
    const page = await buildPage(resolveKind(interaction), 1);
    await interaction.editReply({ ...page, allowedMentions: { parse: [] } });
  } catch (error) {
    const { token } = getBotConfig();
    logger.error('Events command failed', {
      error: safeErrorMessage(error, token === undefined ? [] : [token]),
    });
    await replyWithSafeError(interaction);
  }
}

/** Handle Previous/Next buttons for `/events`. */
export async function handleEventsComponent(
  interaction: CommandComponentInteraction,
): Promise<void> {
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  if (parsed.state !== 'active' && parsed.state !== 'upcoming') return;

  try {
    await interaction.deferUpdate();
    const page = await buildPage(parsed.state, parsed.page);
    await interaction.editReply({ ...page, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    const { token } = getBotConfig();
    logger.error('Events pagination failed', {
      error: safeErrorMessage(error, token === undefined ? [] : [token]),
    });
    await replyWithSafeError(interaction);
  }
}
