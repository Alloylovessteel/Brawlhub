import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { createLogger } from '@brawlhub/logging';
import {
  cancelVerification,
  checkVerification,
  getVerificationChallenge,
  startVerification,
} from '../verification/index.js';
import { checkBotRateLimit } from '../discord/rate-limit.js';
import {
  notifyVerificationCompleted,
  notifyVerificationFailed,
} from '../operator-notifier.js';
import { reconcileGuildRolesForPlayer } from '../role-automation/index.js';

const COMMAND_NAME = 'member-verify';
const CHECK_RATE_LIMIT = 1;
const CHECK_RATE_WINDOW_MS = 30_000;
const logger = createLogger('bot/verification');

function formatTag(tag: string): string {
  return `#${tag}`;
}

function formatExpiry(expiresAt: number): string {
  const unix = Math.max(0, Math.floor(expiresAt / 1000));
  return `<t:${unix}:R>`;
}

async function postVerificationOperatorNotice(
  interaction: ChatInputCommandInteraction,
  result: { playerName: string; playerTag: string },
): Promise<void> {
  if (interaction.guildId === null) return;
  try {
    await notifyVerificationCompleted({
      guildId: interaction.guildId,
      playerName: result.playerName,
      playerTag: result.playerTag,
      discordUserId: interaction.user.id,
      method: 'icon-verified',
    });
  } catch {
    // Operator notices are best-effort.
  }
}

async function postVerificationFailureNotice(
  interaction: ChatInputCommandInteraction,
  input: { readonly playerName: string | null; readonly playerTag: string; readonly reason: string },
): Promise<void> {
  if (interaction.guildId === null) return;
  try {
    await notifyVerificationFailed({
      guildId: interaction.guildId,
      playerName: input.playerName,
      playerTag: input.playerTag,
      discordUsername: interaction.user.globalName ?? interaction.user.username ?? 'unknown',
      reason: input.reason,
    });
  } catch {
    // Operator notices are best-effort.
  }
}

async function reconcileRolesAfterVerification(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.guildId === null) return;
  try {
    const result = await reconcileGuildRolesForPlayer(
      interaction.guildId,
      interaction.user.id,
      { client: interaction.client },
    );
    if (result.kind === 'ok' && (result.rolesAdded > 0 || result.rolesRemoved > 0)) {
      logger.info('Post-verification auto roles reconciled', {
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        rolesAdded: result.rolesAdded,
        rolesRemoved: result.rolesRemoved,
      });
    }
  } catch (error) {
    // Role reconciliation must never make a successful verification look failed.
    logger.warn('Post-verification auto role reconciliation failed', {
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function targetIconEmbed(icon: {
  readonly id: number;
  readonly name: string;
  readonly url: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Required icon: ${icon.name}`)
    .setDescription(
      `Set your Brawl Stars player icon to **${icon.name}** (icon ID \`${icon.id}\`) exactly as shown below. This is a default brawler icon chosen for this verification.`,
    )
    .setImage(icon.url);
}

export const memberVerifyCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Verify ownership of a Brawl Stars player by setting a required default brawler icon')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('start')
      .setDescription('Start verification and get a random required default brawler icon')
      .addStringOption((option) =>
        option
          .setName('tag')
          .setDescription('Your Brawl Stars player tag (e.g. #2ABC)')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('check')
      .setDescription('Check whether your in-game icon matches the required icon shown at start'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel your active verification challenge'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Show your active verification challenge and the required icon'),
  );

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const tag = interaction.options.getString('tag', true);
  const result = await startVerification({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId,
    tagInput: tag,
    discordUsername:
      interaction.user.globalName ?? interaction.user.username ?? null,
  });

  logger.info('Verification start handled', {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    requestedTag: tag,
    outcome: result.ok ? 'ok' : result.code,
    playerTag: result.ok
      ? result.challenge.playerTag
      : result.code === 'active-challenge'
        ? result.challenge.playerTag
        : undefined,
    reused: result.ok ? result.reused === true : false,
    targetIconId: result.ok
      ? result.challenge.targetIconId
      : result.code === 'active-challenge'
        ? result.challenge.targetIconId
        : undefined,
  });

  if (!result.ok) {
    if (result.code === 'active-challenge') {
      const activeIcon = {
        id: result.challenge.targetIconId,
        name: result.challenge.targetIconName,
        url: result.challenge.targetIconUrl,
      };
      await interaction.editReply({
        content: result.message,
        embeds: [targetIconEmbed(activeIcon)],
      });
      return;
    }
    await interaction.editReply({ content: result.message });
    await postVerificationFailureNotice(interaction, {
      playerName: null,
      playerTag: tag,
      reason: result.message,
    });
    return;
  }

  const { challenge } = result;
  const icon = {
    id: challenge.targetIconId,
    name: challenge.targetIconName,
    url: challenge.targetIconUrl,
  };
  const heading = result.reused === true ? 'Existing verification challenge resumed' : 'Verification started';
  const lines = [
    `**${heading} for ${challenge.playerName} (${formatTag(challenge.playerTag)})**`,
    '',
    `1. Open Brawl Stars and change your **player icon** to **${icon.name}** (shown below).`,
    '2. Wait for the official API to update, then run `/members accounts check`. If it is not detected yet, keep this exact icon and check again.',
    `3. This challenge expires ${formatExpiry(challenge.expiresAt)}.`,
    '',
    `Starting icon detected by the official API: \`${challenge.startingIconId}\``,
    `Required icon: **${icon.name}** (ID \`${icon.id}\`) — default brawler icon (randomly selected)`,
    'Re-running `/members accounts verify` for the same player keeps this exact required icon. BrawlHub only verifies ownership when the official Brawl Stars API shows this exact required icon. Changing to any other icon will not verify, and BrawlHub will not infer ownership from names, tags, or Discord profile details.',
  ];
  await interaction.editReply({ content: lines.join('\n'), embeds: [targetIconEmbed(icon)] });
}

async function handleCheck(interaction: ChatInputCommandInteraction): Promise<void> {
  const rateLimit = checkBotRateLimit(
    `member-verify-check:${interaction.guildId ?? 'dm'}:${interaction.user.id}`,
    CHECK_RATE_LIMIT,
    CHECK_RATE_WINDOW_MS,
  );
  if (!rateLimit.allowed) {
    await interaction.editReply({
      content: `Please wait ${rateLimit.retryAfterSeconds} second(s) before checking verification again.`,
    });
    return;
  }

  const result = await checkVerification({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId,
  });
  logger.info('Verification check handled', {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    outcome: result.ok ? result.status : result.code,
    playerTag: result.ok ? result.playerTag : undefined,
    currentIconId: result.ok ? result.currentIconId : undefined,
    targetIconId: result.ok ? result.targetIconId : undefined,
  });

  if (!result.ok) {
    await interaction.editReply({ content: result.message });
    if (result.code !== 'no-challenge') {
      const challenge = getVerificationChallenge({
        discordUserId: interaction.user.id,
        guildId: interaction.guildId,
      });
      await postVerificationFailureNotice(interaction, {
        playerName: challenge?.playerName ?? null,
        playerTag: challenge?.playerTag ?? 'unknown',
        reason: result.message,
      });
    }
    return;
  }

  if (result.status === 'pending') {
    const icon = {
      id: result.targetIconId,
      name: result.targetIconName,
      url: result.targetIconUrl,
    };
    const lines = [
      `**Required icon not detected yet for ${result.playerName} (${formatTag(result.playerTag)})**`,
      '',
      `Current icon ID from the official API: \`${result.currentIconId}\``,
      `Required icon: **${icon.name}** (ID \`${icon.id}\`)`,
      `Keep your in-game player icon set to **${icon.name}** (shown below). The official API can take a few minutes to show a new icon, so run \`/members accounts check\` again shortly.`,
      'Changing to any other icon will not verify ownership.',
      `Challenge expires ${formatExpiry(result.expiresAt)}.`,
    ];
    await interaction.editReply({ content: lines.join('\n'), embeds: [targetIconEmbed(icon)] });
    return;
  }

  const icon = {
    id: result.targetIconId,
    name: result.targetIconName,
    url: result.targetIconUrl,
  };
  await interaction.editReply({
    content:
      `**Verified:** ${result.playerName} (${formatTag(result.playerTag)}) is now linked to your BrawlHub account.\n` +
      `Required icon **${icon.name}** (ID \`${icon.id}\`) was confirmed via the official Brawl Stars API (starting icon \`${result.startingIconId}\`, current \`${result.currentIconId}\`).`,
  });
  await postVerificationOperatorNotice(interaction, result);
  await reconcileRolesAfterVerification(interaction);
}

async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const result = cancelVerification({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId,
  });
  logger.info('Verification cancel handled', {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    hadChallenge: result.ok ? result.hadChallenge : false,
  });
  if (!result.ok) {
    await interaction.editReply({ content: 'Could not cancel verification right now. Please try again later.' });
    return;
  }
  await interaction.editReply({
    content: result.hadChallenge
      ? 'Your verification challenge was cancelled.'
      : 'You do not have an active verification challenge.',
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const challenge = getVerificationChallenge({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId,
  });
  if (challenge === null) {
    await interaction.editReply({
      content: 'No active verification challenge. Run `/members accounts verify tag:<player-tag>` to begin.',
    });
    return;
  }
  const icon = {
    id: challenge.targetIconId,
    name: challenge.targetIconName,
    url: challenge.targetIconUrl,
  };
  await interaction.editReply({
    content:
      `**Active verification challenge**\n` +
      `Player: ${challenge.playerName} (${formatTag(challenge.playerTag)})\n` +
      `Starting icon ID: \`${challenge.startingIconId}\`\n` +
      `Required icon: **${icon.name}** (ID \`${icon.id}\`) — default brawler icon\n` +
      `Expires: ${formatExpiry(challenge.expiresAt)}\n\n` +
      `Set your in-game icon to **${icon.name}** (shown below), then run \`/members accounts check\`. Changing to any other icon will not verify.`,
    embeds: [targetIconEmbed(icon)],
  });
}

export async function handleMemberVerify(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case 'start':
      await handleStart(interaction);
      return;
    case 'check':
      await handleCheck(interaction);
      return;
    case 'cancel':
      await handleCancel(interaction);
      return;
    case 'status':
      await handleStatus(interaction);
      return;
    default:
      await interaction.editReply({
        content: 'Unknown verification action. Use `/members accounts verify`, `check`, `cancel`, or `status`.',
      });
  }
}
