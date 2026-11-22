import { mdBold, mdCode, mdParagraphs } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import {
  EmbedBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { respondToAutocomplete } from '../discord/errors.js';
import { listLinkedAccounts, setMainVerification } from '../verification/index.js';

const COMMAND_NAME = 'accounts';
const EMBED_COLOR = EMBED_COLORS.player;

export const accountsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('View and manage your linked Brawl Stars accounts')
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List your linked accounts, main and alts'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-main')
      .setDescription('Choose which linked account is your main')
      .addStringOption((option) =>
        option
          .setName('tag')
          .setDescription('The linked account to make main')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

function formatTag(tag: string): string {
  return `#${tag}`;
}

function accountsEmbed(
  accounts: Array<{
    readonly tag: string;
    readonly name: string | null;
    readonly isMain: boolean;
    readonly method: string;
    readonly verifiedAt: string | null;
  }>,
): EmbedBuilder {
  const lines = accounts.map((account, index) => {
    const label = account.isMain ? mdBold('MAIN') : 'Alt';
    const name = account.name ?? 'Unknown player';
    const when = account.verifiedAt
      ? ` • linked <t:${Math.floor(Date.parse(account.verifiedAt) / 1000)}:R>`
      : '';
    const method = account.method === 'manual_staff' ? ' • staff-linked' : '';
    return `${index + 1}. ${label} — ${name} (${mdCode(formatTag(account.tag))})${when}${method}`;
  });
  const mainCount = accounts.filter((account) => account.isMain).length;
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Your linked Brawl Stars accounts')
    .setDescription(
      lines.length > 0
        ? mdParagraphs(...lines)
        : mdParagraphs(
            'You have no verified accounts.',
            `Use ${mdCode('/members accounts verify tag:YOURTAG')} to link one.`,
          ),
    )
    .setFooter({ text: `${accounts.length} linked • ${mainCount} main • the rest are alts` });
}

export async function handleAccounts(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  const accounts = await listLinkedAccounts(interaction.user.id);
  if (accounts === null) {
    await interaction.editReply({
      content: 'You do not have a BrawlHub profile yet. Use `/members accounts verify tag:YOURTAG` first.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (interaction.options.getSubcommand() === 'set-main') {
    const tag = interaction.options.getString('tag', true);
    const result = await setMainVerification(interaction.user.id, tag);
    if (result.kind !== 'ok') {
      const message =
        result.kind === 'invalid-tag'
          ? 'That player tag is not valid.'
          : result.kind === 'not-found'
            ? `That account is not linked to you. Use \`/members accounts list\` to see your linked accounts.`
            : 'Could not update your main account right now. Please try again.';
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      return;
    }
    const refreshed = (await listLinkedAccounts(interaction.user.id)) ?? accounts;
    await interaction.editReply({
      content: `Main account set to ${formatTag(result.tag)}.`,
      embeds: [accountsEmbed(refreshed)],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.editReply({
    embeds: [accountsEmbed(accounts)],
    allowedMentions: { parse: [] },
  });
}

export async function handleAccountsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'tag') {
    await respondToAutocomplete(interaction, []);
    return;
  }
  const accounts = await listLinkedAccounts(interaction.user.id);
  const query = focused.value.trim().toLowerCase();
  const choices = (accounts ?? [])
    .filter((account) =>
      query === '' ||
      account.tag.toLowerCase().includes(query) ||
      (account.name ?? '').toLowerCase().includes(query),
    )
    .slice(0, 25)
    .map((account) => ({
      name: `${account.isMain ? '★ MAIN — ' : 'Alt — '}${account.name ?? 'Unknown'} (#${account.tag})`.slice(0, 100),
      value: account.tag,
    }));
  await respondToAutocomplete(interaction, choices);
}
