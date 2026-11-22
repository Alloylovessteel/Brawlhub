import { createLogger } from '@brawlhub/logging';
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors';
import { requireGlobalPermission } from '../admin/service';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import { buildViewTagsEmbed } from '../clubs/overview/embed';
import { refreshOverviewNow } from '../clubs/overview/service';
import {
  addViewTag,
  loadViewTagSummaries,
  readViewTags,
  removeViewTag,
} from '../clubs/view-tags';
import { getBotConfig } from '../config';
import { respondToAutocomplete } from '../discord/errors.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const logger = createLogger('bot');
const COMMAND_NAME = 'view';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const viewCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Choose which registered clubs appear in this server’s club overview')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a registered club to the server overview')
      .addStringOption((option) =>
        option
          .setName('tag')
          .setDescription('Registered club to show (tag or selection)')
          .setAutocomplete(true)
          .setRequired(true)
          .setMaxLength(36),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Stop showing a club in the server overview')
      .addStringOption((option) =>
        option
          .setName('tag')
          .setDescription('Club currently in the overview (tag or selection)')
          .setAutocomplete(true)
          .setRequired(true)
          .setMaxLength(36),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List the clubs in this server’s overview'),
  );

interface ViewPermissionContext {
  readonly guildId: string;
  readonly actor: Awaited<ReturnType<typeof requireGlobalPermission>>;
  readonly guildLabel: string | null;
}

async function requireViewPermission(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): Promise<ViewPermissionContext> {
  const guildId = interaction.guildId ?? '';
  const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  });
  return { guildId, actor, guildLabel: interaction.guild?.name ?? null };
}

async function resolveClubChoice(
  guildId: string,
  raw: string,
): Promise<{ readonly id: string; readonly name: string; readonly tag: string } | null> {
  const clubs = await getRegisteredClubs(guildId);
  const value = raw.trim();
  if (UUID_PATTERN.test(value)) {
    const club = clubs.find((candidate) => candidate.id === value);
    return club === undefined ? null : { id: club.id, name: club.name, tag: club.tag };
  }
  const normalized = value.replace(/^#/, '').trim().toUpperCase();
  const club = clubs.find((candidate) => candidate.tag.toUpperCase() === normalized);
  return club === undefined ? null : { id: club.id, name: club.name, tag: club.tag };
}

async function replyWithOverview(
  interaction: ChatInputCommandInteraction,
  context: ViewPermissionContext,
  action: 'list' | 'added' | 'removed',
  detail: string | null,
): Promise<void> {
  const summaries = await loadViewTagSummaries(context.guildId);
  const embed = buildViewTagsEmbed({
    summaries,
    trackedSummaries: summaries,
    guildLabel: context.guildLabel,
    now: new Date(),
    config: getBotConfig(),
    action,
    detail,
  });
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });

  // Keep the single auto-posted overview in sync without posting another message.
  try {
    await refreshOverviewNow(context.guildId, {
      label: context.guildLabel,
      iconUrl: interaction.guild?.iconURL?.() ?? null,
    });
  } catch (error) {
    logger.warn('Could not refresh the auto-posted overview after view tag change', {
      guildId: context.guildId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

export async function handleView(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const context = await requireViewPermission(interaction);
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand === 'list') {
      await replyWithOverview(interaction, context, 'list', null);
      return;
    }

    const raw = interaction.options.getString('tag', true);
    const club = await resolveClubChoice(context.guildId, raw);
    if (club === null) {
      await interaction.editReply({
        content:
          'That club is not registered in this server. An authorised user must register it first with `/clubs register`.',
        components: [],
      });
      return;
    }

    if (subcommand === 'add') {
      const result = await addViewTag({
        guildId: context.guildId,
        clubId: club.id,
        actor: context.actor,
      });
      if (result.kind === 'limit-reached') {
        await interaction.editReply({
          content: `This overview already tracks ${result.limit} clubs. Remove one before adding another.`,
          components: [],
        });
        return;
      }
      if (result.kind === 'not-found') {
        await interaction.editReply({
          content: 'That club is no longer active in this server. Nothing was changed.',
          components: [],
        });
        return;
      }
      const detail =
        result.kind === 'already-present'
          ? `${club.name} (#${club.tag}) is already in this server’s overview.`
          : `Added ${club.name} (#${club.tag}) to this server’s overview.`;
      await replyWithOverview(interaction, context, 'added', detail);
      return;
    }

    if (subcommand === 'remove') {
      const result = await removeViewTag({
        guildId: context.guildId,
        clubId: club.id,
        actor: context.actor,
      });
      const detail =
        result.kind === 'not-found'
          ? `${club.name} (#${club.tag}) was not in this server’s overview.`
          : `Removed ${club.name} (#${club.tag}) from this server’s overview. The club is still registered.`;
      await replyWithOverview(interaction, context, 'removed', detail);
      return;
    }

    await interaction.editReply({ content: 'Unknown `/clubs view` action.', components: [] });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleViewAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'tag') {
    await respondToAutocomplete(interaction, []);
    return;
  }
  try {
    const context = await requireViewPermission(interaction);
    let clubs = await getRegisteredClubs(context.guildId);
    if (interaction.options.getSubcommand(false) === 'remove') {
      const tags = await readViewTags(context.guildId);
      const ids = new Set(tags.map((tag) => tag.clubId));
      clubs = clubs.filter((club) => ids.has(club.id));
    }
    const choices = filterRegisteredClubs(clubs, String(focused.value)).map((club) => ({
      name: `${club.name} (#${club.tag})`,
      value: club.id,
    }));
    await respondToAutocomplete(interaction, choices);
  } catch {
    await respondToAutocomplete(interaction, [], { swallowUnexpectedErrors: true });
  }
}
