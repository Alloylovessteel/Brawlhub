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
import { buildClubLogPageEmbed } from '../clubs/embed';
import { loadLeaderboardView } from '../clubs/service';
import type { ClubLogPeriod, ClubLogRow, ClubLogView, LeaderboardEntry } from '../clubs/types';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
  type Page,
} from '../discord/pagination';
import {
  DEFAULT_PAGINATION_STATE,
  paginationStateForTag,
  readClubChooserSelection,
  replyClubLookupFailure,
  replyWithClubChooserIfNeeded,
  respondWithClubChoices,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'club-log';
const PAGE_SIZE = 10;
const DEFAULT_PERIOD: ClubLogPeriod = 'today';

const PERIOD_CHOICES: ReadonlyArray<{ readonly name: string; readonly value: ClubLogPeriod }> = [
  { name: 'Daily (Today)', value: 'today' },
  { name: 'Weekly (This Week)', value: 'week' },
  { name: 'Season', value: 'season' },
];

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

interface ClubLogState {
  readonly period: ClubLogPeriod;
  readonly tag: string | undefined;
}

export const clubLogCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show daily or weekly trophy progression for a registered club')
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
      .setDescription('Progression period to display')
      .setRequired(false);
    for (const choice of PERIOD_CHOICES) {
      option.addChoices({ name: choice.name, value: choice.value });
    }
    return option;
  });

function isClubLogPeriod(value: string): value is ClubLogPeriod {
  return PERIOD_CHOICES.some((choice) => choice.value === value);
}

function encodeState(period: ClubLogPeriod, tag: string | undefined): string {
  return `${period}|${paginationStateForTag(tag)}`;
}

function decodeState(state: string): ClubLogState | null {
  const parts = state.split('|');
  if (parts.length !== 2) return null;
  const period = parts[0];
  const tagState = parts[1] ?? DEFAULT_PAGINATION_STATE;
  if (period === undefined || !isClubLogPeriod(period)) return null;
  return { period, tag: tagFromPaginationState(tagState) };
}

function rankByChange(entries: readonly LeaderboardEntry[], period: ClubLogPeriod): ClubLogRow[] {
  const eligible = entries
    .map((entry) => {
      const change = entry.progression?.[period] ?? null;
      return change === null ? null : { member: entry, change };
    })
    .filter((row): row is { member: LeaderboardEntry; change: number } => row !== null)
    .sort((a, b) => b.change - a.change || a.member.name.localeCompare(b.member.name));

  let currentRank = 0;
  let previousChange: number | null = null;
  return eligible.map((entry, index) => {
    if (previousChange === null || entry.change !== previousChange) {
      currentRank = index + 1;
      previousChange = entry.change;
    }
    const { progression: _progression, rank: _rank, ...member } = entry.member;
    return { rank: currentRank, member, change: entry.change };
  });
}

function toView(
  leaderboard: Awaited<ReturnType<typeof loadLeaderboardView>> & { kind: 'ok' },
  period: ClubLogPeriod,
): ClubLogView {
  const value = leaderboard.value;
  const rows = rankByChange(value.entries, period);
  const unavailable = value.entries.filter((entry) => (entry.progression?.[period] ?? null) === null).length;
  return {
    club: value.club,
    period,
    rows,
    unavailable,
    latestSnapshotAt: value.latestSnapshot?.capturedAt ?? null,
    latestSyncAt: value.latestSyncAt,
  };
}

async function loadPage(
  tag: string | undefined,
  guildId: string | null,
  period: ClubLogPeriod,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyClubLookupFailure>[1] }
> {
  const config = getBotConfig();
  const result = await loadLeaderboardView({
    tag,
    guildId,
    seasonStartIso: config.seasonStartIso,
  });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

  const view = toView(result, period);
  const page = paginate(view.rows, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    encodeState(period, tag),
  );

  return {
    kind: 'ok',
    payload: {
      embeds: [buildClubLogPageEmbed(view, page, config)],
      components: row === null ? [] : [row],
    },
  };
}

export async function handleClubLog(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const rawPeriod = interaction.options.getString('period', false);
  const period: ClubLogPeriod =
    rawPeriod !== null && isClubLogPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;
  const tag = interaction.options.getString('tag', false) ?? undefined;
  const built = await loadPage(tag, interaction.guildId, period, 1);

  if (built.kind === 'lookup-failure') {
    if (
      await replyWithClubChooserIfNeeded(interaction, COMMAND_NAME, built.failure, { period })
    ) {
      return;
    }
    await replyClubLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
}

export async function handleClubLogComponent(interaction: CommandComponentInteraction): Promise<void> {
  const chooser = readClubChooserSelection<{ readonly period: ClubLogPeriod }>(interaction, COMMAND_NAME);
  if (chooser.kind !== 'none') {
    try {
      await interaction.deferUpdate();
      if (chooser.kind === 'expired') {
        await interaction.editReply({
          content: 'That club chooser expired. Run the command again.',
          embeds: [],
          components: [],
        });
        return;
      }
      const built = await loadPage(chooser.tag, interaction.guildId, chooser.state.period, 1);
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
      logger.error('Club log chooser failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await replyWithSafeError(interaction);
    }
    return;
  }

  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeState(parsed.state);
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
    logger.error('Club log pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleClubLogAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction, 'tag');
}
