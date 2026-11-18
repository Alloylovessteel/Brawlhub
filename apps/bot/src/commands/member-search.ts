import { createLogger } from '@brawlhub/logging';
import { discordIdSchema } from '@brawlhub/shared';
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
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import { buildMemberSearchPageEmbed } from '../membership/embed';
import {
  INVALID_SEARCH_MESSAGE,
  normalizeMemberSearchQuery,
  searchTrackedMembersByDiscord,
  searchTrackedMembersByPlayer,
} from '../membership/service';
import type {
  MemberSearchFailure,
  MemberSearchMode,
  MemberSearchView,
} from '../membership/types';
import { respondWithPlayerChoices } from './player-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'member-search';
const PAGE_SIZE = 10;
const INVALID_SUBCOMMAND_MESSAGE = 'Choose either the `player` or `discord` search.';

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

type BuildResult =
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'failure'; readonly failure: MemberSearchFailure };

interface SearchState {
  readonly mode: MemberSearchMode;
  readonly query: string;
}

export const memberSearchCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Search tracked players by name, tag or stored Discord identity link')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('player')
      .setDescription('Search stored players by name or tag')
      .addStringOption((option) =>
        option
          .setName('query')
          .setDescription('Player name or tag, for example Alpha or 2C0Y')
          .setAutocomplete(true)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(32),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('discord')
      .setDescription('Search players linked to a Discord user ID (staff or self only)')
      .addStringOption((option) =>
        option
          .setName('user')
          .setDescription('Discord user ID (17–20 digits)')
          .setRequired(true)
          .setMinLength(17)
          .setMaxLength(20),
      ),
  );

/** Compact base64url state keeps custom IDs short and free of colon separators. */
export function encodeMemberSearchState(state: SearchState): string {
  const prefix = state.mode === 'player' ? 'p' : 'd';
  return Buffer.from(`${prefix}|${state.query}`, 'utf8').toString('base64url');
}

export function decodeMemberSearchState(state: string): SearchState | null {
  const decoded = Buffer.from(state, 'base64url').toString('utf8');
  const divider = decoded.indexOf('|');
  if (divider <= 0) return null;
  const prefix = decoded.slice(0, divider);
  const rawQuery = decoded.slice(divider + 1);

  if (prefix === 'p') {
    const query = normalizeMemberSearchQuery(rawQuery);
    return query === null ? null : { mode: 'player', query };
  }
  if (prefix === 'd') {
    const parsed = discordIdSchema.safeParse(rawQuery);
    return parsed.success ? { mode: 'discord', query: parsed.data } : null;
  }
  return null;
}

async function runSearch(
  state: SearchState,
  actorDiscordUserId: string,
): Promise<
  | { readonly kind: 'ok'; readonly value: MemberSearchView }
  | { readonly kind: 'failure'; readonly failure: MemberSearchFailure }
> {
  const result = state.mode === 'player'
    ? await searchTrackedMembersByPlayer(state.query)
    : await searchTrackedMembersByDiscord(state.query, actorDiscordUserId);
  return result.kind === 'ok'
    ? { kind: 'ok', value: result.value }
    : { kind: 'failure', failure: result };
}

async function buildPage(
  state: SearchState,
  actorDiscordUserId: string,
  pageNumber: number,
): Promise<BuildResult> {
  const result = await runSearch(state, actorDiscordUserId);
  if (result.kind === 'failure') return { kind: 'failure', failure: result.failure };

  const page = paginate(result.value.entries, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    encodeMemberSearchState({ mode: result.value.mode, query: result.value.query }),
  );
  return {
    kind: 'ok',
    payload: {
      embeds: [buildMemberSearchPageEmbed(result.value, page, getBotConfig())],
      components: row === null ? [] : [row],
    },
  };
}

async function replyFailure(
  interaction: ChatInputCommandInteraction,
  failure: MemberSearchFailure,
): Promise<void> {
  await interaction.reply({ content: failure.message, ephemeral: true });
}

export async function handleMemberSearch(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  let state: SearchState | null = null;
  let inputRejected = false;

  if (subcommand === 'player') {
    const rawQuery = interaction.options.getString('query', true);
    const query = normalizeMemberSearchQuery(rawQuery);
    if (query !== null) state = { mode: 'player', query };
    else inputRejected = true;
  } else if (subcommand === 'discord') {
    const rawId = interaction.options.getString('user', true);
    const parsed = discordIdSchema.safeParse(rawId);
    if (parsed.success) state = { mode: 'discord', query: parsed.data };
    else inputRejected = true;
  }

  if (state === null) {
    await interaction.reply({
      content: inputRejected ? INVALID_SEARCH_MESSAGE : INVALID_SUBCOMMAND_MESSAGE,
      ephemeral: true,
    });
    return;
  }

  const built = await buildPage(state, interaction.user.id, 1);
  if (built.kind === 'failure') {
    await replyFailure(interaction, built.failure);
    return;
  }
  await interaction.reply({ ...built.payload, allowedMentions: { parse: [] } });
}

export async function handleMemberSearchComponent(interaction: ButtonInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeMemberSearchState(parsed.state);
  if (state === null) return;

  try {
    await interaction.deferUpdate();
    const built = await buildPage(state, interaction.user.id, parsed.page);
    if (built.kind === 'failure') {
      await interaction.editReply({
        content: 'This search is no longer available.',
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Member search pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleMemberSearchAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  await respondWithPlayerChoices(interaction, 'query');
}
