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
import { getBotConfig } from '../config';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import { replyWithSafeError } from '../discord/errors';
import { buildPlayerClubsPageEmbed } from '../players/embed';
import { loadPlayerClubs } from '../players/service';
import {
  playerPaginationStateForTag,
  playerTagFromPaginationState,
  replyPlayerLookupFailure,
  respondWithPlayerChoices,
} from './player-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'player-clubs';
const PAGE_SIZE = 10;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const playerClubsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show a player’s stored club membership history')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  );

async function loadPage(
  tag: string,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyPlayerLookupFailure>[1] }
> {
  const result = await loadPlayerClubs({ tag });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

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

export async function handlePlayerClubs(interaction: ChatInputCommandInteraction): Promise<void> {
  const tag = interaction.options.getString('tag', true);
  const built = await loadPage(tag, 1);

  if (built.kind === 'lookup-failure') {
    await replyPlayerLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.reply({ ...built.payload, allowedMentions: { parse: [] } });
}

export async function handlePlayerClubsComponent(interaction: ButtonInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const tag = playerTagFromPaginationState(parsed.state);
  if (tag === undefined) return;

  try {
    await interaction.deferUpdate();
    const built = await loadPage(tag, parsed.page);
    if (built.kind === 'lookup-failure') {
      await interaction.editReply({
        content: 'This player is no longer available.',
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Player clubs pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handlePlayerClubsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithPlayerChoices(interaction, 'tag');
}
