import { createLogger } from '@brawlhub/logging';
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config.js';
import { replyWithSafeError } from '../discord/errors';
import { cleanTag, escapeMarkdown } from '../discord/format';
import { resolveBrawlerPortraitUrl, resolvePlayerIconUrl } from '../metadata/assets.js';
import {
  buildPlayerCardImage,
  selectTopBrawlers,
  type PlayerCardAssets,
  type PlayerCardOptions,
  type PlayerHistorySummary,
} from '../players/card.js';
import { loadPlayerHistory, loadPlayerProfile } from '../players/service';
import { listLinkedAccounts, type LinkedAccountView } from '../verification/index.js';
import { DEFAULT_ME_IMAGE_MODE, isMeImageMode } from './me-image-modes.js';
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

/** Build the truthful history summary used by the Player History preset. */
async function loadHistorySummary(
  tag: string,
  guildId: string | null,
): Promise<PlayerHistorySummary | null> {
  if (guildId === null) return null;
  try {
    const result = await loadPlayerHistory({ tag, guildId, period: '30d' });
    if (result.kind !== 'ok') return null;
    const view = result.value;
    const first = view.points[0] ?? null;
    const latest = view.points.at(-1) ?? null;
    return {
      points: view.points.length,
      firstAt: first?.capturedAt ?? null,
      latestAt: latest?.capturedAt ?? null,
      firstTrophies: first?.trophies ?? null,
      latestTrophies: latest?.trophies ?? null,
      clubChanges: view.events.length,
      nameChanges: null,
    };
  } catch {
    return null;
  }
}

/** Resolve static portraits for the brawlers shown by a grid/focus preset. */
async function resolveModePortraits(
  profileBrawlers: ReadonlyArray<{ readonly name: string; readonly trophies: number }>,
  mode: string,
): Promise<Record<string, string | null>> {
  const sorted = [...profileBrawlers].sort((left, right) => right.trophies - left.trophies);
  const names =
    mode === 'brawler'
      ? sorted.slice(0, 1).map((brawler) => brawler.name)
      : sorted.slice(0, 24).map((brawler) => brawler.name);
  const urls = await Promise.all(names.map((name) => resolveBrawlerPortraitUrl(name)));
  return Object.fromEntries(names.map((name, index) => [name, urls[index] ?? null]));
}

/** Post a public BrawlTools-style player image card for the resolved player. */
export async function handleMeImage(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const rawMode = interaction.options.getString('mode', false);
  const mode = isMeImageMode(rawMode) ? rawMode : DEFAULT_ME_IMAGE_MODE;

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

    let assets: PlayerCardAssets = {
      playerIconUrl,
      brawlerPortraitUrls,
      badges: badgesFor(linkedAccounts, profile.player.tag),
    };
    let options: PlayerCardOptions = { mode };

    if (mode === 'season') {
      const config = getBotConfig();
      options = {
        mode,
        seasonWindow: {
          start: config.seasonStartIso ?? null,
          end: config.seasonEndIso ?? null,
        },
      };
    } else if (mode === 'history') {
      options = { mode, history: await loadHistorySummary(resolved.tag, interaction.guildId) };
    } else if (mode !== 'profile') {
      assets = {
        ...assets,
        allBrawlerPortraitUrls: await resolveModePortraits(profile.brawlers, mode),
      };
    }

    const image = await buildPlayerCardImage(profile, assets, options);
    const clean = cleanTag(profile.player.tag);
    const fileName = mode === 'profile' ? `brawlhub-${clean}.png` : `brawlhub-${clean}-${mode}.png`;
    const label = mode === 'profile' ? 'Player card' : `${mode.replaceAll('_', ' ')} card`;

    const attachment = new AttachmentBuilder(image, { name: fileName });
    await interaction.editReply({
      content: `${label} for ${escapeMarkdown(profile.player.name)} (\`#${profile.player.tag}\`)`,
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
