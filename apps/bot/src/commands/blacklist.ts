import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getBotConfig } from '../config';
import {
  buildPaginationRowWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import {
  buildBlacklistAddConfirmationEmbed,
  buildBlacklistAddedEmbed,
  buildBlacklistListEmbed,
  buildBlacklistRemovedEmbed,
} from '../moderation/embed';
import {
  addBlacklist,
  canManageBlacklists,
  listActiveBlacklists,
  ModerationServiceError,
  removeBlacklist,
  resolveBlacklistTarget,
  resolveModerationActor,
} from '../moderation/service';
import type { AddBlacklistInput, RemoveBlacklistInput } from '../moderation/types';

const COMMAND_NAME = 'blacklist';
const PAGE_SIZE = 5;
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REASON = 'No reason provided';
const FORBIDDEN_MESSAGE = 'You do not have permission to manage blacklists.';

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

interface PendingActionBase {
  readonly actorDiscordUserId: string;
  readonly expiresAt: number;
}

interface PendingAddAction extends PendingActionBase {
  readonly kind: 'add';
  readonly input: AddBlacklistInput;
}

interface PendingRemoveAction extends PendingActionBase {
  readonly kind: 'remove';
  readonly input: RemoveBlacklistInput;
}

type PendingBlacklistAction = PendingAddAction | PendingRemoveAction;

const pendingActions = new Map<string, PendingBlacklistAction>();

/** Reset the ephemeral confirmation store (used by tests). */
export function clearPendingBlacklistActions(): void {
  pendingActions.clear();
}

export const blacklistCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Manage BrawlHub moderation blacklists')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a tracked Brawl Stars player to the active blacklist')
      .addStringOption((option) =>
        option
          .setName('player')
          .setDescription('Brawl Stars player tag, for example 2C0Y')
          .setRequired(true)
          .setMaxLength(20),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why the player is being blacklisted')
          .setRequired(false)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove an active blacklist entry (original record is preserved)')
      .addStringOption((option) =>
        option
          .setName('entry')
          .setDescription('Blacklist entry to remove')
          .setAutocomplete(true)
          .setRequired(true)
          .setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why the entry is being removed')
          .setRequired(false)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List active blacklists')
      .addStringOption((option) =>
        option
          .setName('search')
          .setDescription('Filter by player tag, name, reason or staff member')
          .setRequired(false)
          .setMaxLength(32),
      ),
  );

function optionString(interaction: ChatInputCommandInteraction, name: string): string {
  return interaction.options.getString(name, false) ?? '';
}

function buildConfirmationRow(nonce: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMMAND_NAME}:confirm:${nonce}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${COMMAND_NAME}:cancel:${nonce}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildRemovalConfirmationEmbed(blacklistId: string, reason: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('Confirm blacklist removal')
    .setDescription(
      'The entry will no longer be active. Its original record is preserved for audit history.',
    )
    .addFields(
      { name: 'Entry ID', value: `\`${blacklistId}\`` },
      { name: 'Reason', value: reason === '' ? DEFAULT_REASON : reason },
    );
}

async function requireBlacklistManager(discordUserId: string): Promise<void> {
  const actor = await resolveModerationActor(discordUserId);
  if (!canManageBlacklists(actor)) {
    throw new ModerationServiceError('forbidden', FORBIDDEN_MESSAGE);
  }
}

async function buildListPage(
  search: string,
  pageNumber: number,
  actorDiscordUserId: string,
): Promise<PagePayload> {
  const view = await listActiveBlacklists(
    { search: search || null },
    { actorDiscordUserId },
  );
  const page = paginate(view.entries, pageNumber, PAGE_SIZE);
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    search,
  );
  return {
    embeds: [buildBlacklistListEmbed(view, page, getBotConfig())],
    components: row === null ? [] : [row],
  };
}

async function replyModerationError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
  if (!(error instanceof ModerationServiceError)) throw error;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content: error.message, ephemeral: true });
    return;
  }
  await interaction.reply({ content: error.message, ephemeral: true });
}

export async function handleBlacklist(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  const actorDiscordUserId = interaction.user.id;
  try {
    if (subcommand === 'add') {
      await requireBlacklistManager(actorDiscordUserId);
      const target = await resolveBlacklistTarget(optionString(interaction, 'player'));
      const reason = optionString(interaction, 'reason').trim() || DEFAULT_REASON;
      const input: AddBlacklistInput = {
        discordUserId: actorDiscordUserId,
        tag: target.tag,
        reason,
      };
      const nonce = randomUUID();
      pendingActions.set(nonce, {
        kind: 'add',
        actorDiscordUserId,
        input,
        expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
      });
      await interaction.reply({
        embeds: [buildBlacklistAddConfirmationEmbed(target, reason, actorDiscordUserId)],
        components: [buildConfirmationRow(nonce)],
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'remove') {
      await requireBlacklistManager(actorDiscordUserId);
      const blacklistId = optionString(interaction, 'entry');
      const reason = optionString(interaction, 'reason').trim();
      const input: RemoveBlacklistInput = {
        discordUserId: actorDiscordUserId,
        blacklistId,
        reason: reason === '' ? null : reason,
      };
      const nonce = randomUUID();
      pendingActions.set(nonce, {
        kind: 'remove',
        actorDiscordUserId,
        input,
        expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
      });
      await interaction.reply({
        embeds: [buildRemovalConfirmationEmbed(blacklistId, reason)],
        components: [buildConfirmationRow(nonce)],
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'list') {
      const search = optionString(interaction, 'search');
      await interaction.reply({
        ...(await buildListPage(search, 1, actorDiscordUserId)),
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.reply({ content: 'Choose a blacklist subcommand.', ephemeral: true });
  } catch (error) {
    await replyModerationError(interaction, error);
  }
}

export async function handleBlacklistAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'entry') {
    await interaction.respond([]);
    return;
  }
  try {
    const view = await listActiveBlacklists(
      { search: String(focused.value) },
      { actorDiscordUserId: interaction.user.id },
    );
    const choices = view.entries.slice(0, 25).map((entry) => ({
      name: `${entry.playerTag === null ? entry.id : `#${entry.playerTag}`} — ${entry.reason}`,
      value: entry.id,
    }));
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]).catch(() => undefined);
  }
}

interface PendingActionRef {
  readonly kind: 'confirm' | 'cancel';
  readonly nonce: string;
}

function parseActionCustomId(customId: string): PendingActionRef | null {
  const [commandName, action, nonce] = customId.split(':');
  if (
    commandName !== COMMAND_NAME ||
    (action !== 'confirm' && action !== 'cancel') ||
    nonce === undefined ||
    nonce === ''
  ) {
    return null;
  }
  return { kind: action, nonce };
}

function takePendingAction(
  nonce: string,
  actorDiscordUserId: string,
): PendingBlacklistAction {
  const action = pendingActions.get(nonce);
  if (action === undefined) {
    throw new ModerationServiceError('not_found', 'That confirmation is no longer valid.');
  }
  if (action.expiresAt <= Date.now()) {
    pendingActions.delete(nonce);
    throw new ModerationServiceError('not_found', 'That confirmation has expired. Run the command again.');
  }
  if (action.actorDiscordUserId !== actorDiscordUserId) {
    throw new ModerationServiceError('forbidden', 'That confirmation belongs to another moderator.');
  }
  // Delete before mutating so a confirmation can never be replayed.
  pendingActions.delete(nonce);
  return action;
}

export async function handleBlacklistComponent(interaction: ButtonInteraction): Promise<void> {
  const pagination = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  const actionRef = pagination === null ? parseActionCustomId(interaction.customId) : null;
  if (pagination === null && actionRef === null) return;

  try {
    await interaction.deferUpdate();
    if (pagination !== null) {
      await interaction.editReply({
        ...(await buildListPage(pagination.state, pagination.page, interaction.user.id)),
        content: null,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (actionRef === null) return;
    const action = takePendingAction(actionRef.nonce, interaction.user.id);
    if (actionRef.kind === 'cancel') {
      await interaction.editReply({
        content: 'Blacklist action cancelled.',
        embeds: [],
        components: [],
      });
      return;
    }

    await requireBlacklistManager(interaction.user.id);
    if (action.kind === 'add') {
      const result = await addBlacklist(action.input);
      await interaction.editReply({
        embeds: [buildBlacklistAddedEmbed(result, interaction.user.id)],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const result = await removeBlacklist(action.input);
    await interaction.editReply({
      embeds: [buildBlacklistRemovedEmbed(result)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyModerationError(interaction, error);
  }
}
