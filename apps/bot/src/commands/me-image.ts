import { createLogger } from '@brawlhub/logging';
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config.js';
import { replyWithSafeError } from '../discord/errors';
import { cleanTag, escapeMarkdown } from '../discord/format';
import { resolveBrawlerPortraitUrl, resolvePlayerIconUrl } from '../metadata/assets.js';
import {
  buildPlayerCardImage,
  type ModeWinStat,
  type PlayerCardAssets,
  type PlayerCardOptions,
  type PlayerHistorySummary,
  type PlayerSnapshotPoint,
} from '../players/card.js';
import {
  loadPlayerBattles,
  loadPlayerBrawlers,
  loadPlayerHistory,
  loadPlayerProfile,
} from '../players/service';
import type {
  PlayerBattleRecord,
  PlayerBrawler,
  PlayerBrawlerDetail,
} from '../players/types';
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

interface LoadedHistory {
  readonly summary: PlayerHistorySummary | null;
  readonly snapshots: readonly PlayerSnapshotPoint[];
}

/** Convert an official battle mode id such as `brawlBall` into `Brawl Ball`. */
function modeLabel(mode: string | null): string {
  if (mode === null || mode.trim() === '') return 'Unknown';
  return mode
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Build the truthful history summary and trophy points used by the presets. */
async function loadHistoryData(
  tag: string,
  guildId: string | null,
  period: '7d' | '30d' | '90d' | 'all' = '30d',
  now: Date = new Date(),
): Promise<LoadedHistory> {
  if (guildId === null) return { summary: null, snapshots: [] };
  try {
    const result = await loadPlayerHistory({ tag, guildId, period, now });
    if (result.kind !== 'ok') return { summary: null, snapshots: [] };
    const view = result.value;
    const first = view.points[0] ?? null;
    const latest = view.points.at(-1) ?? null;
    const events = view.events.map((event) => {
      const from = event.fromClub?.name ?? 'a club';
      const to = event.toClub?.name ?? 'a club';
      const label =
        event.eventType === 'join'
          ? `Joined ${to}`
          : event.eventType === 'leave'
            ? `Left ${from}`
            : `${from} → ${to}`;
      return { type: event.eventType, label, date: event.detectedAt };
    });
    const megaPig = view.player.megaPig ?? null;
    return {
      summary: {
        points: view.points.length,
        firstAt: first?.capturedAt ?? null,
        latestAt: latest?.capturedAt ?? null,
        firstTrophies: first?.trophies ?? null,
        latestTrophies: latest?.trophies ?? null,
        clubChanges: view.events.length,
        nameChanges: null,
        events,
        megaPig:
          megaPig === null
            ? null
            : {
                date: megaPig.date ?? null,
                wins: megaPig.wins ?? null,
                draws: megaPig.draws ?? null,
                losses: megaPig.losses ?? null,
                ticketsUsed: megaPig.ticketsUsed ?? null,
              },
      },
      snapshots: view.points.map((point) => ({
        date: point.capturedAt,
        trophies: point.trophies,
      })),
    };
  } catch {
    return { summary: null, snapshots: [] };
  }
}

interface LoadedBattles {
  readonly battles: readonly PlayerBattleRecord[];
  readonly modeStats: readonly ModeWinStat[];
}

/**
 * Load every stored official battle for the season preset. The raw records are
 * needed for the date/match bars, while mode rates are aggregated from the
 * same ranked and trophy battles.
 */
async function loadBattleData(
  tag: string,
  guildId: string | null,
  now: Date,
): Promise<LoadedBattles> {
  const empty: LoadedBattles = { battles: [], modeStats: [] };
  if (guildId === null) return empty;
  try {
    const result = await loadPlayerBattles({ tag, guildId, period: 'all', now });
    if (result.kind !== 'ok') return empty;
    const battles = result.value.battles;
    const counts = new Map<string, { wins: number; matches: number }>();
    for (const battle of battles) {
      const label = modeLabel(battle.mode);
      const entry = counts.get(label) ?? { wins: 0, matches: 0 };
      entry.matches += 1;
      if (battle.result?.toLowerCase() === 'victory') entry.wins += 1;
      counts.set(label, entry);
    }
    return {
      battles,
      modeStats: [...counts.entries()]
        .map(([label, entry]) => ({
          label,
          wins: entry.wins,
          matches: entry.matches,
          winRate: entry.matches === 0 ? null : (entry.wins / entry.matches) * 100,
        }))
        .sort((left, right) => right.matches - left.matches),
    };
  } catch {
    return empty;
  }
}

/** Resolve static portraits for the brawlers shown by a grid/focus preset. */
async function resolveModePortraits(
  profileBrawlers: ReadonlyArray<{ readonly name: string; readonly trophies: number }>,
): Promise<Record<string, string | null>> {
  const sorted = [...profileBrawlers].sort((left, right) => right.trophies - left.trophies);
  const names = sorted.slice(0, 24).map((brawler) => brawler.name);
  const urls = await Promise.all(names.map((name) => resolveBrawlerPortraitUrl(name)));
  return Object.fromEntries(names.map((name, index) => [name, urls[index] ?? null]));
}

/** Convert the full official brawler detail list into card-grid brawlers. */
function toCardBrawler(detail: PlayerBrawlerDetail): PlayerBrawler | null {
  if (detail.trophies === null) return null;
  return {
    name: detail.name,
    trophies: detail.trophies,
    highestTrophies: detail.highestTrophies ?? null,
    power: detail.power ?? null,
    rank: detail.rank ?? null,
    prestigeLevel: detail.prestigeLevel ?? null,
    currentWinStreak: detail.currentWinStreak ?? null,
    maxWinStreak: detail.maxWinStreak ?? null,
    gadgets: detail.gadgets.length,
    starPowers: detail.starPowers.length,
    gears: detail.gears.length,
    hyperCharges: detail.hyperCharges.length,
  };
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
    const now = new Date();
    const [profileResult, linkedAccounts, brawlerResult] = await Promise.all([
      loadPlayerProfile({ tag: resolved.tag, guildId: interaction.guildId, now }),
      listLinkedAccounts(interaction.user.id).catch(() => null),
      loadPlayerBrawlers({ tag: resolved.tag, guildId: interaction.guildId, now }).catch(() => null),
    ]);
    if (profileResult.kind !== 'ok') {
      await replyPlayerLookupFailure(interaction, profileResult);
      return;
    }

    const profile = profileResult.value;
    const details = brawlerResult?.kind === 'ok' ? brawlerResult.value.brawlers : [];
    const fullBrawlers = details
      .map(toCardBrawler)
      .filter((brawler): brawler is PlayerBrawler => brawler !== null);
    // The profile view only carries eight brawlers. Every preset uses the full
    // official brawler list when available so counts and grids are accurate.
    const cardBrawlers = fullBrawlers.length > 0 ? fullBrawlers : profile.brawlers;
    const topBrawlers = [...cardBrawlers]
      .sort((left, right) => right.trophies - left.trophies)
      .slice(0, 3);
    const [playerIconUrl, ...brawlerPortraitUrls] = await Promise.all([
      resolvePlayerIconUrl(profile.player.iconId),
      ...topBrawlers.map((brawler) => resolveBrawlerPortraitUrl(brawler.name)),
    ]);

    let assets: PlayerCardAssets = {
      playerIconUrl,
      brawlerPortraitUrls,
      badges: badgesFor(linkedAccounts, profile.player.tag),
    };
    let options: PlayerCardOptions = { mode, brawlers: cardBrawlers, now };

    if (mode === 'season') {
      const config = getBotConfig();
      const seasonWindow = {
        start: config.seasonStartIso ?? null,
        end: config.seasonEndIso ?? null,
      };
      let snapshots: readonly PlayerSnapshotPoint[] = [];
      let battles: readonly PlayerBattleRecord[] = [];
      let modeStats: readonly ModeWinStat[] = [];

      // Stored history is guild-scoped. Without a guild we can only show the
      // official current trophy point, never cross-guild graph data.
      if (interaction.guildId !== null) {
        const [history, battleData] = await Promise.all([
          loadHistoryData(resolved.tag, interaction.guildId, 'all', now),
          loadBattleData(resolved.tag, interaction.guildId, now),
        ]);
        snapshots = history.snapshots;
        battles = battleData.battles;
        modeStats = battleData.modeStats;
      }

      options = { mode, brawlers: cardBrawlers, now, seasonWindow, snapshots, battles, modeStats };
    } else if (mode === 'history') {
      const history = await loadHistoryData(resolved.tag, interaction.guildId, '30d', now);
      options = { mode, brawlers: cardBrawlers, now, history: history.summary, snapshots: history.snapshots };
    } else if (mode === 'brawler' || mode === 'rank' || mode === 'trophies' || mode === 'highest') {
      const topName = topBrawlers[0]?.name;
      const detail = topName === undefined ? null : details.find((brawler) => brawler.name === topName) ?? null;
      options = {
        ...options,
        ...(mode === 'brawler' ? { brawlerDetail: detail } : {}),
      };
      assets = {
        ...assets,
        allBrawlerPortraitUrls: await resolveModePortraits(cardBrawlers),
      };
    }

    const image = await buildPlayerCardImage(profile, assets, options);
    const clean = cleanTag(profile.player.tag);
    const fileName = mode === 'profile' ? `brawlhub-${clean}.png` : `brawlhub-${clean}-${mode}.png`;
    const label =
      mode === 'profile'
        ? 'Player card'
        : mode === 'season'
          ? 'Season progress'
          : `${mode.replaceAll('_', ' ')} card`;

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
