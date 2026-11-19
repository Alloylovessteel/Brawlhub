import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  cancelVerification,
  checkVerification,
  getVerificationChallenge,
  startVerification,
} from '../verification/index.js';

const COMMAND_NAME = 'member-verify';

function formatTag(tag: string): string {
  return `#${tag}`;
}

function formatExpiry(expiresAt: number): string {
  const unix = Math.max(0, Math.floor(expiresAt / 1000));
  return `<t:${unix}:R>`;
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
    tagInput: tag,
    discordUsername:
      interaction.user.globalName ?? interaction.user.username ?? null,
  });

  if (!result.ok) {
    await interaction.editReply({ content: result.message });
    return;
  }

  const { challenge } = result;
  const icon = {
    id: challenge.targetIconId,
    name: challenge.targetIconName,
    url: challenge.targetIconUrl,
  };
  const lines = [
    `**Verification started for ${challenge.playerName} (${formatTag(challenge.playerTag)})**`,
    '',
    `1. Open Brawl Stars and change your **player icon** to **${icon.name}** (shown below).`,
    '2. Wait a moment for the official API to update, then run `/member-verify check`.',
    `3. This challenge expires ${formatExpiry(challenge.expiresAt)}.`,
    '',
    `Starting icon detected by the official API: \`${challenge.startingIconId}\``,
    `Required icon: **${icon.name}** (ID \`${icon.id}\`) — default brawler icon (randomly selected)`,
    'BrawlHub only verifies ownership when the official Brawl Stars API shows this exact required icon. Changing to any other icon will not verify, and BrawlHub will not infer ownership from names, tags, or Discord profile details.',
  ];
  await interaction.editReply({ content: lines.join('\n'), embeds: [targetIconEmbed(icon)] });
}

async function handleCheck(interaction: ChatInputCommandInteraction): Promise<void> {
  const result = await checkVerification({ discordUserId: interaction.user.id });
  if (!result.ok) {
    await interaction.editReply({ content: result.message });
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
      `Set your in-game player icon to **${icon.name}** (shown below), wait briefly, then run \`/member-verify check\` again.`,
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
}

async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const result = cancelVerification({ discordUserId: interaction.user.id });
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
  const challenge = getVerificationChallenge({ discordUserId: interaction.user.id });
  if (challenge === null) {
    await interaction.editReply({
      content: 'No active verification challenge. Run `/member-verify start tag:<player-tag>` to begin.',
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
      `Set your in-game icon to **${icon.name}** (shown below), then run \`/member-verify check\`. Changing to any other icon will not verify.`,
    embeds: [targetIconEmbed(icon)],
  });
}

export async function handleMemberVerify(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
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
        content: 'Unknown verification action. Use `/member-verify start`, `check`, `cancel`, or `status`.',
      });
  }
}
