import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getBotConfig } from '../config';
import { buildClubMembersPageEmbed } from '../clubs/embed';
import { loadMemberView } from '../clubs/service';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import {
  paginationStateForTag,
  replyClubLookupFailure,
  respondWithClubChoices,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'club-members';
const PAGE_SIZE = 10;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const clubMembersCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show the latest synchronised members of a registered club')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Registered club tag, for example #ABCD1234')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );

async function buildPage(
  tag: string | undefined,
  guildId: string | null,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyClubLookupFailure>[1] }
> {
  const result = await loadMemberView({ tag, guildId });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

  const page = paginate(result.value.members, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    paginationStateForTag(tag),
  );

  return {
    kind: 'ok',
    payload: {
      embeds: [buildClubMembersPageEmbed(result.value, page, getBotConfig())],
      components: row === null ? [] : [row],
    },
  };
}

export async function handleClubMembers(interaction: ChatInputCommandInteraction): Promise<void> {
  const tag = interaction.options.getString('tag', false) ?? undefined;
  const built = await buildPage(tag, interaction.guildId, 1);

  if (built.kind === 'lookup-failure') {
    await replyClubLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.reply({ ...built.payload, allowedMentions: { parse: [] } });
}

export async function handleClubMembersComponent(interaction: CommandComponentInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;

  try {
    await interaction.deferUpdate();
    const built = await buildPage(tagFromPaginationState(parsed.state), interaction.guildId, parsed.page);
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
    logger.error('Club members pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleClubMembersAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction);
}
