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
import { buildLeaderboardPageEmbed } from '../clubs/embed';
import { loadLeaderboardView } from '../clubs/service';
import type { LeaderboardEntry } from '../clubs/types';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
  type Page,
} from '../discord/pagination';
import {
  paginationStateForTag,
  readClubChooserSelection,
  replyClubLookupFailure,
  replyWithClubChooserIfNeeded,
  respondWithClubChoices,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'club-leaderboard';
const PAGE_SIZE = 10;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const clubLeaderboardCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show a club trophy leaderboard from stored player data')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Registered club tag, for example #ABCD1234')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );

function buildLeaderboardPage(
  entries: readonly LeaderboardEntry[],
  view: Parameters<typeof buildLeaderboardPageEmbed>[0],
  pageNumber: number,
  tag: string | undefined,
): { page: Page<LeaderboardEntry>; payload: PagePayload } {
  const page = paginate(entries, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    paginationStateForTag(tag),
  );

  return {
    page,
    payload: {
      embeds: [buildLeaderboardPageEmbed(view, page, getBotConfig())],
      components: row === null ? [] : [row],
    },
  };
}

async function loadPage(
  tag: string | undefined,
  guildId: string | null,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyClubLookupFailure>[1] }
> {
  const result = await loadLeaderboardView({
    tag,
    guildId,
    seasonStartIso: getBotConfig().seasonStartIso,
  });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

  return {
    kind: 'ok',
    payload: buildLeaderboardPage(result.value.entries, result.value, pageNumber, tag).payload,
  };
}

export async function handleClubLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const tag = interaction.options.getString('tag', false) ?? undefined;
  const built = await loadPage(tag, interaction.guildId, 1);

  if (built.kind === 'lookup-failure') {
    if (await replyWithClubChooserIfNeeded(interaction, COMMAND_NAME, built.failure, null)) return;
    await replyClubLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
}

export async function handleClubLeaderboardComponent(interaction: CommandComponentInteraction): Promise<void> {
  const chooser = readClubChooserSelection<null>(interaction, COMMAND_NAME);
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
      const built = await loadPage(chooser.tag, interaction.guildId, 1);
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
      logger.error('Club leaderboard chooser failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await replyWithSafeError(interaction);
    }
    return;
  }

  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;

  try {
    await interaction.deferUpdate();
    const built = await loadPage(
      tagFromPaginationState(parsed.state),
      interaction.guildId,
      parsed.page,
    );
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
    logger.error('Club leaderboard pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleClubLeaderboardAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction);
}
