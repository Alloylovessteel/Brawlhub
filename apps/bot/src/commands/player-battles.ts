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
import { resolveBrawlerPortraitUrl, resolvePlayerIconUrl } from '../metadata/assets.js';
import { buildPlayerBattlesPageEmbed } from '../players/embed';
import { loadPlayerBattles } from '../players/service';
import type { HistoryPeriod } from '../clubs/types';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import {
  DEFAULT_PLAYER_PERIOD,
  isPlayerHistoryPeriod,
  PLAYER_PERIOD_CHOICES,
  playerPaginationStateForTag,
  playerTagFromPaginationState,
  replyPlayerLookupFailure,
  respondWithPlayerChoices,
} from './player-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'player-battles';
const PAGE_SIZE = 10;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

interface HistoryState {
  readonly period: HistoryPeriod;
  readonly tag: string | undefined;
}

export const playerBattlesCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show stored battle history for a Brawl Stars player')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  )
  .addStringOption((option) => {
    option
      .setName('period')
      .setDescription('Time period to display')
      .setRequired(false);
    for (const choice of PLAYER_PERIOD_CHOICES) {
      option.addChoices({ name: choice.name, value: choice.value });
    }
    return option;
  });

function encodeState(period: HistoryPeriod, tag: string): string {
  return `${period}|${playerPaginationStateForTag(tag)}`;
}

function decodeState(state: string): HistoryState | null {
  const parts = state.split('|');
  if (parts.length !== 2) return null;
  const period = parts[0];
  const tagState = parts[1];
  if (period === undefined || tagState === undefined || !isPlayerHistoryPeriod(period)) {
    return null;
  }
  return { period, tag: playerTagFromPaginationState(tagState) };
}

async function loadPage(
  tag: string,
  period: HistoryPeriod,
  guildId: string | null,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyPlayerLookupFailure>[1] }
> {
  const result = await loadPlayerBattles({ tag, period, guildId });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

  const page = paginate(result.value.battles, pageNumber, PAGE_SIZE);
  const [iconUrl, battlePortraitUrl] = await Promise.all([
    resolvePlayerIconUrl(result.value.player.iconId),
    resolveBrawlerPortraitUrl(page.items[0]?.brawlerName ?? null),
  ]);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    encodeState(period, tag),
  );

  return {
    kind: 'ok',
    payload: {
      embeds: [
        buildPlayerBattlesPageEmbed(result.value, page, getBotConfig(), iconUrl, battlePortraitUrl),
      ],
      components: row === null ? [] : [row],
    },
  };
}

export async function handlePlayerBattles(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const tag = interaction.options.getString('tag', true);
  const rawPeriod = interaction.options.getString('period', false);
  const period = rawPeriod !== null && isPlayerHistoryPeriod(rawPeriod) ? rawPeriod : DEFAULT_PLAYER_PERIOD;
  const built = await loadPage(tag, period, interaction.guildId, 1);

  if (built.kind === 'lookup-failure') {
    await replyPlayerLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
}

export async function handlePlayerBattlesComponent(interaction: CommandComponentInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeState(parsed.state);
  if (state === null || state.tag === undefined) return;

  try {
    await interaction.deferUpdate();
    const built = await loadPage(state.tag, state.period, interaction.guildId, parsed.page);
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
    logger.error('Player battle history pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handlePlayerBattlesAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithPlayerChoices(interaction, 'tag');
}
