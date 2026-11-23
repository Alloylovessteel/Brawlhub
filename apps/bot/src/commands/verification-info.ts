import { mdBold, mdCode, mdList, mdParagraphs, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors.js';
import { loadGuildSettings, requireGlobalPermission } from '../admin/service.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const EMBED_COLOR = EMBED_COLORS.success;

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
      mdParagraphs(
        mdSection(
          'Steps',
          [
            `${mdBold('1.')} Run \`/verify tag tag:YOURTAG\` with your player tag.`,
            `${mdBold('2.')} The bot shows a randomly chosen default brawler icon and its exact ID.`,
            `${mdBold('3.')} In Brawl Stars, set your player icon to that exact brawler and keep it equipped.`,
            `${mdBold('4.')} The bot checks the official Brawl Stars API automatically. An exact match links the account to your Discord user; \`/verify check\` is an immediate manual fallback.`,
          ].join('\n'),
        ),
        mdSection(
          'Notes',
          mdList([
            'Challenges expire after 30 minutes. Ownership is never guessed from names, tags or profile pictures.',
            'After verifying, use `/verify accounts list` to see your main and alt accounts, and `/verify accounts set-main tag:TAG` to change your main.',
          ]),
        ),
      ),
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
        { name: 'Server', value: mdCode(interaction.guildId ?? 'none'), inline: true },
        { name: 'Verified role', value: role, inline: true },
        {
          name: 'Method',
          value: 'Random default-brawler icon challenge with automatic official Brawl Stars API checks (30 minute TTL).',
        },
        {
          name: 'Change settings',
          value: `${mdCode('/verify set-verified-role role:ROLE')} or ${mdCode('/settings setup')}.`,
        },
      );
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
