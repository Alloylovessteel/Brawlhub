import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

export const MEMBER_VERIFY_UNAVAILABLE_MESSAGE =
  'Account verification is not currently available. BrawlHub will not infer player ownership from Discord usernames, nicknames, player tags or role names, and this command never creates verification records.';

export const memberVerifyCommandData = new SlashCommandBuilder()
  .setName('member-verify')
  .setDescription('Explain the current player-ownership verification limitation');

/** Always report the limitation: no trusted verification flow is exposed to the bot. */
export async function handleMemberVerify(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: MEMBER_VERIFY_UNAVAILABLE_MESSAGE, ephemeral: true });
}
