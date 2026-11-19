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
import { buildHistoryPageEmbed } from '../clubs/embed';
import { loadHistoryView } from '../clubs/service';
import type { HistoryPeriod } from '../clubs/types';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import {
  DEFAULT_PAGINATION_STATE,
  paginationStateForTag,
  replyClubLookupFailure,
  respondWithClubChoices,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'club-history';
const PAGE_SIZE = 10;
const DEFAULT_PERIOD: HistoryPeriod = '30d';

const PERIOD_CHOICES: ReadonlyArray<{ readonly name: string; readonly value: HistoryPeriod }> = [
  { name: '7 days', value: '7d' },
  { name: '30 days', value: '30d' },
  { name: '90 days', value: '90d' },
  { name: 'All available history', value: 'all' },
];

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

interface HistoryState {
  readonly period: HistoryPeriod;
  readonly tag: string | undefined;
}

export const clubHistoryCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show stored historical statistics for a registered club')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Registered club tag, for example #ABCD1234')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  )
  .addStringOption((option) => {
    option
      .setName('period')
      .setDescription('Time period to display')
      .setRequired(false);
    for (const choice of PERIOD_CHOICES) {
      option.addChoices({ name: choice.name, value: choice.value });
    }
    return option;
  });

function isHistoryPeriod(value: string): value is HistoryPeriod {
  return PERIOD_CHOICES.some((choice) => choice.value === value);
}

function encodeHistoryState(period: HistoryPeriod, tag: string | undefined): string {
  return `${period}|${paginationStateForTag(tag)}`;
}

function decodeHistoryState(state: string): HistoryState | null {
  const parts = state.split('|');
  if (parts.length !== 2) return null;
  const period = parts[0];
  const tagState = parts[1] ?? DEFAULT_PAGINATION_STATE;
  if (period === undefined || !isHistoryPeriod(period)) return null;
  return { period, tag: tagFromPaginationState(tagState) };
}

async function loadPage(
  tag: string | undefined,
  guildId: string | null,
  period: HistoryPeriod,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyClubLookupFailure>[1] }
> {
  const result = await loadHistoryView({
    tag,
    guildId,
    period,
    seasonStartIso: getBotConfig().seasonStartIso,
  });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

  const page = paginate(result.value.points, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    encodeHistoryState(period, tag),
  );

  return {
    kind: 'ok',
    payload: {
      embeds: [buildHistoryPageEmbed(result.value, page, getBotConfig())],
      components: row === null ? [] : [row],
    },
  };
}

export async function handleClubHistory(interaction: ChatInputCommandInteraction): Promise<void> {
  const rawPeriod = interaction.options.getString('period', false);
  const period: HistoryPeriod = rawPeriod !== null && isHistoryPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;
  const tag = interaction.options.getString('tag', false) ?? undefined;
  const built = await loadPage(tag, interaction.guildId, period, 1);

  if (built.kind === 'lookup-failure') {
    await replyClubLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.reply({ ...built.payload, allowedMentions: { parse: [] } });
}

export async function handleClubHistoryComponent(interaction: ButtonInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeHistoryState(parsed.state);
  if (state === null) return;

  try {
    await interaction.deferUpdate();
    const built = await loadPage(state.tag, interaction.guildId, state.period, parsed.page);
    if (built.kind === 'lookup-failure') {
      await interaction.editReply({
        content: 'This club is no longer available.',
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Club history pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleClubHistoryAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction, 'tag');
}
