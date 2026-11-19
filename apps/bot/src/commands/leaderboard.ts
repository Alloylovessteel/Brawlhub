import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
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
import { isProgressionPeriod } from '../leaderboard/calculate';
import {
  buildClubLeaderboardPageEmbed,
  buildPlayerLeaderboardPageEmbed,
  buildProgressionLeaderboardPageEmbed,
  buildTrophyLeaderboardPageEmbed,
} from '../leaderboard/embed';
import {
  loadClubLeaderboard,
  loadPlayerLeaderboard,
  loadProgressionLeaderboard,
  loadTrophyLeaderboard,
} from '../leaderboard/service';
import type { ProgressionPeriod } from '../leaderboard/types';

const logger = createLogger('bot');
const COMMAND_NAME = 'leaderboard';
const PAGE_SIZE = 10;
const DEFAULT_PERIOD: ProgressionPeriod = '30d';

type LeaderboardKind = 'clubs' | 'players' | 'trophies' | 'progression';

interface LeaderboardState {
  readonly kind: LeaderboardKind;
  readonly period: ProgressionPeriod;
}

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

const PERIOD_CHOICES = [
  { name: '7 days', value: '7d' },
  { name: '30 days', value: '30d' },
  { name: '90 days', value: '90d' },
] as const;

export const leaderboardCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show global BrawlHub leaderboards')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('clubs')
      .setDescription('Rank registered clubs by total trophies'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('players')
      .setDescription('Rank tracked players by current trophies'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('trophies')
      .setDescription('Rank tracked players by recorded personal bests'),
  )
  .addSubcommand((subcommand) => {
    subcommand
      .setName('progression')
      .setDescription('Rank players by trophy gains over a period')
      .addStringOption((option) => {
        const built = option
          .setName('period')
          .setDescription('Snapshot period to compare')
          .setRequired(false);
        for (const choice of PERIOD_CHOICES) {
          built.addChoices({ name: choice.name, value: choice.value });
        }
        return built;
      });
    return subcommand;
  });

function encodeState(kind: LeaderboardKind, period: ProgressionPeriod): string {
  return kind === 'progression' ? `${kind}|${period}` : kind;
}

function decodeState(state: string): LeaderboardState | null {
  const [kind, rawPeriod] = state.split('|');
  if (kind === 'clubs' || kind === 'players' || kind === 'trophies') {
    return { kind, period: DEFAULT_PERIOD };
  }
  if (
    kind === 'progression' &&
    rawPeriod !== undefined &&
    isProgressionPeriod(rawPeriod)
  ) {
    return { kind, period: rawPeriod };
  }
  return null;
}

function stateFromSubcommand(subcommand: string | null): LeaderboardState | null {
  if (subcommand === 'clubs' || subcommand === 'players' || subcommand === 'trophies') {
    return { kind: subcommand, period: DEFAULT_PERIOD };
  }
  if (subcommand === 'progression') {
    return { kind: 'progression', period: DEFAULT_PERIOD };
  }
  return null;
}

function paginationFor(
  kind: LeaderboardKind,
  period: ProgressionPeriod,
  page: ReturnType<typeof paginate>,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    encodeState(kind, period),
  );
  return row === null ? [] : [row];
}

async function loadPage(
  state: LeaderboardState,
  guildId: string | null,
  pageNumber: number,
): Promise<PagePayload> {
  const config = getBotConfig();

  if (state.kind === 'clubs') {
    const view = await loadClubLeaderboard({ guildId });
    const page = paginate(view.rows, pageNumber, PAGE_SIZE);
    return {
      embeds: [buildClubLeaderboardPageEmbed(view, page, config)],
      components: paginationFor(state.kind, state.period, page),
    };
  }

  if (state.kind === 'players') {
    const view = await loadPlayerLeaderboard({ guildId });
    const page = paginate(view.rows, pageNumber, PAGE_SIZE);
    return {
      embeds: [buildPlayerLeaderboardPageEmbed(view, page, config)],
      components: paginationFor(state.kind, state.period, page),
    };
  }

  if (state.kind === 'trophies') {
    const view = await loadTrophyLeaderboard({ guildId });
    const page = paginate(view.rows, pageNumber, PAGE_SIZE);
    return {
      embeds: [buildTrophyLeaderboardPageEmbed(view, page, config)],
      components: paginationFor(state.kind, state.period, page),
    };
  }

  const view = await loadProgressionLeaderboard({ period: state.period }, { guildId });
  const page = paginate(view.rows, pageNumber, PAGE_SIZE);
  return {
    embeds: [buildProgressionLeaderboardPageEmbed(view, page, config)],
    components: paginationFor(state.kind, state.period, page),
  };
}

export async function handleLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = stateFromSubcommand(interaction.options.getSubcommand(false));
  if (state === null) {
    await interaction.reply({ content: 'Choose a leaderboard subcommand.', flags: 64 });
    return;
  }

  try {
    await interaction.deferReply();
    let resolved = state;
    if (state.kind === 'progression') {
      const rawPeriod = interaction.options.getString('period', false);
      if (rawPeriod !== null && isProgressionPeriod(rawPeriod)) {
        resolved = { kind: 'progression', period: rawPeriod };
      }
    }

    const payload = await loadPage(resolved, interaction.guildId, 1);
    await interaction.editReply({ ...payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Global leaderboard command failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: 'Something went wrong. Please try again later.',
        embeds: [],
        components: [],
      }).catch(() => undefined);
      return;
    }
    await replyWithSafeError(interaction);
  }
}

export async function handleLeaderboardComponent(interaction: CommandComponentInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeState(parsed.state);
  if (state === null) return;

  try {
    await interaction.deferUpdate();
    const payload = await loadPage(state, interaction.guildId, parsed.page);
    await interaction.editReply({ ...payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Global leaderboard pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}
