import { EMBED_COLORS } from '../discord/embed-style';
import { mdCode, mdList, mdParagraphs, mdSection } from '../discord/embed-format';
import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors';
import {
  loadGuildSettings,
  requireGlobalPermission,
  updateGuildOverviewFields,
} from '../admin/service';
import type { AdminActor } from '../admin/types';
import {
  OVERVIEW_FIELD_KEYS,
  OVERVIEW_FIELD_LABELS,
  hasOverviewField,
  isOverviewFieldKey,
  toggleOverviewField,
} from '../clubs/overview/fields';
import { refreshOverviewNow } from '../clubs/overview/service';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';

const logger = createLogger('bot');
const COMMAND_NAME = 'club-overview';
const CUSTOM_ID_PREFIX = `${COMMAND_NAME}:`;
const TOGGLE_PREFIX = `${CUSTOM_ID_PREFIX}toggle:`;
const DONE_PREFIX = `${CUSTOM_ID_PREFIX}done:`;

export const clubOverviewCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Choose which details appear in this server’s club overview')
  .addSubcommand((subcommand) =>
    subcommand.setName('menu').setDescription('Open the overview field selection menu'),
  );

interface OverviewMenuContext {
  readonly guildId: string;
  readonly actor: AdminActor;
  readonly guildLabel: string | null;
  readonly iconUrl: string | null;
}

async function requireOverviewPermission(
  interaction: ChatInputCommandInteraction | CommandComponentInteraction,
): Promise<OverviewMenuContext> {
  const guildId = interaction.guildId;
  if (guildId === null) {
    throw new Error('The overview menu can only be used in a Discord server.');
  }
  const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', {
    guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  });
  return {
    guildId,
    actor,
    guildLabel: interaction.guild?.name ?? null,
    iconUrl: interaction.guild?.iconURL() ?? null,
  };
}

/** Build the toggle menu for one guild's stored field selection. */
export function buildOverviewMenu(
  guildId: string,
  fields: readonly string[],
  notice?: string | null,
) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.neutral)
    .setTitle('Club overview fields')
    .setDescription(
      notice ??
        mdSection(
          'Field selection',
          mdParagraphs(
            'Choose a field to show or hide in this server’s auto-posted overview.',
            'Changes apply to the next refresh; at least one field stays enabled.',
          ),
        ),
    )
    .addFields({
      name: 'Enabled now',
      value: mdList(
        OVERVIEW_FIELD_KEYS.filter((key) => hasOverviewField(fields, key)).map((key) =>
          mdCode(OVERVIEW_FIELD_LABELS[key]),
        ),
      ),
    });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(toggleCustomId(guildId))
    .setPlaceholder('Toggle an overview field…')
    .addOptions(
      OVERVIEW_FIELD_KEYS.map((key) => ({
        label: `${hasOverviewField(fields, key) ? '✅' : '❌'} ${OVERVIEW_FIELD_LABELS[key]}`.slice(0, 100),
        value: key,
        description: hasOverviewField(fields, key)
          ? 'Currently shown — select to hide'
          : 'Currently hidden — select to show',
      })),
    );
  const done = new ButtonBuilder()
    .setCustomId(doneCustomId(guildId))
    .setLabel('Done')
    .setStyle(ButtonStyle.Success);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(done),
    ],
    allowedMentions: { parse: [] as const },
  };
}

function parseToggleCustomId(customId: string): string | null {
  if (!customId.startsWith(TOGGLE_PREFIX)) return null;
  const guildId = customId.slice(TOGGLE_PREFIX.length);
  return guildId.length > 0 ? guildId : null;
}

function parseDoneCustomId(customId: string): string | null {
  if (!customId.startsWith(DONE_PREFIX)) return null;
  const guildId = customId.slice(DONE_PREFIX.length);
  return guildId.length > 0 ? guildId : null;
}

function toggleCustomId(guildId: string): string {
  return `${TOGGLE_PREFIX}${guildId}`;
}

function doneCustomId(guildId: string): string {
  return `${DONE_PREFIX}${guildId}`;
}

async function refreshAfterChange(context: OverviewMenuContext): Promise<void> {
  try {
    await refreshOverviewNow(context.guildId, {
      label: context.guildLabel,
      iconUrl: context.iconUrl,
    });
  } catch (error) {
    logger.warn('Could not refresh the overview after a field change', {
      guildId: context.guildId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

export async function handleClubOverview(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (interaction.options.getSubcommand(false) !== 'menu') {
      await interaction.reply({ content: 'Choose `/clubs fields`.', flags: MessageFlags.Ephemeral });
      return;
    }
    const context = await requireOverviewPermission(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const settings = await loadGuildSettings(context.guildId);
    await interaction.editReply(buildOverviewMenu(context.guildId, settings.overviewFields));
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleClubOverviewComponent(
  interaction: CommandComponentInteraction,
): Promise<void> {
  try {
    const doneGuildId = parseDoneCustomId(interaction.customId);
    if (doneGuildId !== null) {
      if (doneGuildId !== interaction.guildId) return;
      await requireOverviewPermission(interaction);
      await interaction.deferUpdate();
      await interaction.editReply({
        content: 'Club overview field selection closed.',
        embeds: [],
        components: [],
      });
      return;
    }

    const guildId = parseToggleCustomId(interaction.customId);
    if (guildId === null) return;
    // The guild encoded in the component must match the interacting guild.
    if (guildId !== interaction.guildId) return;
    if (!interaction.isStringSelectMenu()) return;

    const context = await requireOverviewPermission(interaction);
    await interaction.deferUpdate();
    const settings = await loadGuildSettings(guildId);
    const selected = interaction.values[0];
    if (selected === undefined || !isOverviewFieldKey(selected)) {
      await interaction.editReply(
        buildOverviewMenu(guildId, settings.overviewFields, 'Unknown field selection.'),
      );
      return;
    }

    const next = toggleOverviewField(settings.overviewFields, selected);
    const unchanged = next.length === settings.overviewFields.length &&
      next.every((key, index) => key === settings.overviewFields[index]);
    await updateGuildOverviewFields({
      actor: context.actor,
      guildId,
      fields: next,
    });
    await refreshAfterChange(context);

    const notice = unchanged && next.length === 1
      ? 'At least one field must stay enabled; nothing was changed.'
      : `${OVERVIEW_FIELD_LABELS[selected]} ${hasOverviewField(next, selected) ? 'enabled' : 'disabled'} for this server.`;
    await interaction.editReply(buildOverviewMenu(guildId, next, notice));
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
