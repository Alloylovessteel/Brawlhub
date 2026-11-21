import { createLogger } from '@brawlhub/logging';
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { replyWithSafeError } from '../discord/errors';
import { cleanTag, escapeMarkdown } from '../discord/format';
import { resolveBrawlerPortraitUrl, resolvePlayerIconUrl } from '../metadata/assets.js';
import { buildPlayerCardImage, selectTopBrawlers } from '../players/card.js';
import { loadPlayerProfile } from '../players/service';
import { listLinkedAccounts, type LinkedAccountView } from '../verification/index.js';
import { meTagErrorMessage, resolveMeTag } from './me-utils.js';
import { replyPlayerLookupFailure } from './player-utils';

const logger = createLogger('bot');

/** Badges come only from this Discord user's active verification links. */
function badgesFor(accounts: readonly LinkedAccountView[] | null, tag: string): string[] {
  if (accounts === null) return [];
  const linked = accounts.find((account) => cleanTag(account.tag) === cleanTag(tag));
  if (linked === undefined) return [];
  return linked.isMain ? ['VERIFIED', 'MAIN'] : ['VERIFIED', 'ALT'];
}

/** Post a public Spotlight-style profile card for the resolved player. */
export async function handleMeImage(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const resolved = await resolveMeTag(interaction, 'image');
  if (resolved.kind !== 'ok') {
    await interaction.editReply({
      content: meTagErrorMessage(resolved, 'image'),
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    const [profileResult, linkedAccounts] = await Promise.all([
      loadPlayerProfile({ tag: resolved.tag, guildId: interaction.guildId }),
      listLinkedAccounts(interaction.user.id).catch(() => null),
    ]);
    if (profileResult.kind !== 'ok') {
      await replyPlayerLookupFailure(interaction, profileResult);
      return;
    }

    const profile = profileResult.value;
    const brawlers = selectTopBrawlers(profile);
    const [playerIconUrl, ...brawlerPortraitUrls] = await Promise.all([
      resolvePlayerIconUrl(profile.player.iconId),
      ...brawlers.map((brawler) => resolveBrawlerPortraitUrl(brawler.name)),
    ]);

    const image = await buildPlayerCardImage(profile, {
      playerIconUrl,
      brawlerPortraitUrls,
      badges: badgesFor(linkedAccounts, profile.player.tag),
    });

    const attachment = new AttachmentBuilder(image, {
      name: `brawlhub-${cleanTag(profile.player.tag)}.png`,
    });
    await interaction.editReply({
      content: `Player card for ${escapeMarkdown(profile.player.name)} (\`#${profile.player.tag}\`)`,
      files: [attachment],
      // Image cards are public in the channel and never carry components.
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Failed to build /me image card', {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyWithSafeError(interaction);
  }
}
