import {
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

export const memberVerifyCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Verify ownership of a Brawl Stars player by changing your in-game icon')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('start')
      .setDescription('Start icon-change verification for a Brawl Stars player tag')
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
      .setDescription('Check whether your in-game icon change has been detected'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel your active verification challenge'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Show your active verification challenge, if any'),
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
  const lines = [
    `**Verification started for ${challenge.playerName} (${formatTag(challenge.playerTag)})**`,
    '',
    '1. Open Brawl Stars and change your **player icon** to any **different** icon.',
    '2. Wait a moment for the change to be visible, then run `/member-verify check`.',
    `3. This challenge expires ${formatExpiry(challenge.expiresAt)}.`,
    '',
    `Current icon ID detected by the official API: \`${challenge.originalIconId}\``,
    'BrawlHub only verifies ownership when it detects your icon changed in the official Brawl Stars API. It will not infer ownership from names, tags alone, or Discord profile details.',
  ];
  await interaction.editReply({ content: lines.join('\n') });
}

async function handleCheck(interaction: ChatInputCommandInteraction): Promise<void> {
  const result = await checkVerification({ discordUserId: interaction.user.id });
  if (!result.ok) {
    await interaction.editReply({ content: result.message });
    return;
  }

  if (result.status === 'unchanged') {
    const lines = [
      `**Icon change not detected yet for ${result.playerName} (${formatTag(result.playerTag)})**`,
      '',
      `The official API still shows icon ID \`${result.currentIconId}\` (same as when you started).`,
      'Change your in-game player icon to a different icon, wait briefly, then run `/member-verify check` again.',
      `Challenge expires ${formatExpiry(result.expiresAt)}.`,
    ];
    await interaction.editReply({ content: lines.join('\n') });
    return;
  }

  await interaction.editReply({
    content:
      `**Verified:** ${result.playerName} (${formatTag(result.playerTag)}) is now linked to your BrawlHub account.\n` +
      `Icon changed from \`${result.previousIconId}\` to \`${result.currentIconId}\` (confirmed via official Brawl Stars API).`,
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
  await interaction.editReply({
    content:
      `**Active verification challenge**\n` +
      `Player: ${challenge.playerName} (${formatTag(challenge.playerTag)})\n` +
      `Original icon ID: \`${challenge.originalIconId}\`\n` +
      `Expires: ${formatExpiry(challenge.expiresAt)}\n\n` +
      'Change your in-game icon to a different one, then run `/member-verify check`.',
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
