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
import { buildMembersPageEmbed } from '../membership/embed';
import { loadTrackedMembers } from '../membership/service';
import type { MemberLookupFailure } from '../membership/types';
import {
  paginationStateForTag,
  respondWithClubChoices,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'members';
const PAGE_SIZE = 10;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

type BuildResult =
  | { readonly kind: 'ok'; readonly payload: PagePayload }
  | { readonly kind: 'failure'; readonly failure: MemberLookupFailure };

export const membersCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show tracked members across registered clubs')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Optional registered club tag, for example #ABCD1234')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );

async function replyFailure(
  interaction: ChatInputCommandInteraction,
  failure: MemberLookupFailure,
): Promise<void> {
  await interaction.reply({ content: failure.message, flags: 64 });
}

async function buildPage(
  tag: string | undefined,
  guildId: string | null,
  pageNumber: number,
): Promise<BuildResult> {
  const result = await loadTrackedMembers({ tag, guildId });
  if (result.kind !== 'ok') return { kind: 'failure', failure: result };

  const page = paginate(result.value.records, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    paginationStateForTag(tag),
  );
  const payload: PagePayload = {
    embeds: [buildMembersPageEmbed(result.value, page, getBotConfig())],
    components: row === null ? [] : [row],
  };
  return { kind: 'ok', payload };
}

export async function handleMembers(interaction: ChatInputCommandInteraction): Promise<void> {
  const tag = interaction.options.getString('tag', false) ?? undefined;
  const built = await buildPage(tag, interaction.guildId, 1);
  if (built.kind === 'failure') {
    await replyFailure(interaction, built.failure);
    return;
  }
  await interaction.reply({ ...built.payload, allowedMentions: { parse: [] } });
}

export async function handleMembersComponent(interaction: CommandComponentInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;

  try {
    await interaction.deferUpdate();
    const built = await buildPage(
      tagFromPaginationState(parsed.state),
      interaction.guildId,
      parsed.page,
    );
    if (built.kind === 'failure') {
      await interaction.editReply({
        content: 'This club is no longer available.',
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Member pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleMembersAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction, 'tag');
}
