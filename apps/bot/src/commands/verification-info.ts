import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors.js';
import { loadGuildSettings, requireGlobalPermission } from '../admin/service.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const EMBED_COLOR = 0x5865_f2;

export const verifyInfoCommandData = new SlashCommandBuilder()
  .setName('verify-info')
  .setDescription('Post the BrawlHub player verification guide in this channel');

export const verifySettingsCommandData = new SlashCommandBuilder()
  .setName('verify-settings')
  .setDescription('Show this server’s verification settings');

function permissionContext(interaction: ChatInputCommandInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

export async function handleVerifyInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  try {
    await requireGlobalPermission(interaction.user.id, 'members:verify', permissionContext(interaction));
  } catch (error) {
    await replyAdminError(interaction, error);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('How to verify your Brawl Stars account')
    .setDescription(
      [
        '**1.** Run `/members account verify start tag:YOURTAG` with your player tag.',
        '**2.** The bot shows a randomly chosen default brawler icon and its exact ID.',
        '**3.** In Brawl Stars, set your player icon to that exact brawler, then run `/members account verify check`.',
        '**4.** The bot reads your current icon from the official Brawl Stars API. An exact match links the account to your Discord user.',
        '',
        'Challenges expire after 10 minutes. Ownership is never guessed from names, tags or profile pictures.',
        'After verifying, use `/members account list` to see your main and alt accounts, and `/members account set-main tag:TAG` to change your main.',
      ].join('\n'),
    )
    .setFooter({ text: 'BrawlHub • verification is required for account-linked features' });

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export async function handleVerifySettings(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  try {
    await requireGlobalPermission(interaction.user.id, 'members:verify', permissionContext(interaction));
  } catch (error) {
    await replyAdminError(interaction, error);
    return;
  }

  try {
    const settings = await loadGuildSettings(interaction.guildId ?? '');
    const role = settings.verifiedRoleId === null
      ? 'Not configured'
      : `<@&${settings.verifiedRoleId}>`;
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Verification settings')
      .addFields(
        { name: 'Server', value: `\`${interaction.guildId ?? 'none'}\``, inline: true },
        { name: 'Verified role', value: role, inline: true },
        {
          name: 'Method',
          value: 'Random default-brawler icon challenge via the official Brawl Stars API (10 minute TTL).',
        },
        {
          name: 'Change settings',
          value: '`/settings set-verified-role role:ROLE` or `/settings setup`.',
        },
      );
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
