import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getBotConfig } from '../config';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import { buildPlayerClubsPageEmbed } from '../players/embed';
import { loadPlayerClubs } from '../players/service';
import {
  playerPaginationStateForTag,
  playerTagFromPaginationState,
  replyPlayerLookupFailure,
  respondWithPlayerChoices,
} from './player-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'member-history';
const PAGE_SIZE = 10;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

type BuildResult =
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | {
      readonly kind: 'failure';
      readonly failure: Parameters<typeof replyPlayerLookupFailure>[1];
    };

export const memberHistoryCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show a player’s stored club history, transfers and membership dates')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  );

async function buildPage(tag: string, guildId: string | null, pageNumber: number): Promise<BuildResult> {
  const result = await loadPlayerClubs({ tag, guildId });
  if (result.kind !== 'ok') return { kind: 'failure', failure: result };

  const page = paginate(result.value.memberships, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    playerPaginationStateForTag(tag),
  );
  return {
    kind: 'ok',
    payload: {
      embeds: [buildPlayerClubsPageEmbed(result.value, page, getBotConfig())],
      components: row === null ? [] : [row],
    },
  };
}

export async function handleMemberHistory(interaction: ChatInputCommandInteraction): Promise<void> {
  const tag = interaction.options.getString('tag', true);
  const built = await buildPage(tag, interaction.guildId, 1);
  if (built.kind === 'failure') {
    await replyPlayerLookupFailure(interaction, built.failure);
    return;
  }
  await interaction.reply({ ...built.payload, allowedMentions: { parse: [] } });
}

export async function handleMemberHistoryComponent(interaction: CommandComponentInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const tag = playerTagFromPaginationState(parsed.state);
  if (tag === undefined) return;

  try {
    await interaction.deferUpdate();
    const built = await buildPage(tag, interaction.guildId, parsed.page);
    if (built.kind === 'failure') {
      await interaction.editReply({
        content: 'This player is no longer available.',
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Member history pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleMemberHistoryAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  await respondWithPlayerChoices(interaction, 'tag');
}
