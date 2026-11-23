import { createLogger } from '@brawlhub/logging';
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config.js';
import { replyWithSafeError } from '../discord/errors';
import { cleanTag, escapeMarkdown } from '../discord/format';
import { loadOrRenderChart } from '../images/chart-service.js';
import { resolveBrawlerPortraitUrl, resolvePlayerIconUrl } from '../metadata/assets.js';
import {
  buildPlayerCardImage,
  selectTopBrawlers,
  type ModeWinStat,
  type PlayerCardAssets,
  type PlayerCardCharts,
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
async function loadHistoryData(tag: string, guildId: string | null): Promise<LoadedHistory> {
  if (guildId === null) return { summary: null, snapshots: [] };
  try {
    const result = await loadPlayerHistory({ tag, guildId, period: '30d' });
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

/** Aggregate stored official battles into mode win rates for the season preset. */
async function loadModeStats(tag: string, guildId: string | null): Promise<readonly ModeWinStat[]> {
  if (guildId === null) return [];
  try {
    const result = await loadPlayerBattles({ tag, guildId, period: '30d' });
    if (result.kind !== 'ok') return [];
    const counts = new Map<string, { wins: number; matches: number }>();
    for (const battle of result.value.battles) {
      const label = modeLabel(battle.mode);
      const entry = counts.get(label) ?? { wins: 0, matches: 0 };
      entry.matches += 1;
      if (battle.result?.toLowerCase() === 'victory') entry.wins += 1;
      counts.set(label, entry);
    }
    return [...counts.entries()]
      .map(([label, entry]) => ({
        label,
        wins: entry.wins,
        matches: entry.matches,
        winRate: entry.matches === 0 ? null : (entry.wins / entry.matches) * 100,
      }))
      .sort((left, right) => right.matches - left.matches)
      .slice(0, 8);
  } catch {
    return [];
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
      const seasonWindow = {
        start: config.seasonStartIso ?? null,
        end: config.seasonEndIso ?? null,
      };
      let snapshots: readonly PlayerSnapshotPoint[] = [];
      let modeStats: readonly ModeWinStat[] = [];
      let charts: PlayerCardCharts | null = null;

      // Stored history is guild-scoped. Without a guild we can only show the
      // current official snapshot, never cross-guild graph data.
      if (interaction.guildId !== null) {
        const [history, stats, trophyChart, activityChart] = await Promise.all([
          loadHistoryData(resolved.tag, interaction.guildId),
          loadModeStats(resolved.tag, interaction.guildId),
          loadOrRenderChart({
            guildId: interaction.guildId,
            kind: 'player',
            tag: resolved.tag,
            option: 'trophies',
            period: '30d',
          }),
          loadOrRenderChart({
            guildId: interaction.guildId,
            kind: 'player',
            tag: resolved.tag,
            option: 'activity',
            period: '30d',
          }),
        ]);
        snapshots = history.snapshots;
        modeStats = stats;
        if (trophyChart.kind === 'ok' && activityChart.kind === 'ok') {
          charts = {
            trophyChartPng: trophyChart.image.png,
            activityChartPng: activityChart.image.png,
          };
        }
      }

      options = { mode, seasonWindow, snapshots, modeStats, charts };
    } else if (mode === 'history') {
      const history = await loadHistoryData(resolved.tag, interaction.guildId);
      options = { mode, history: history.summary, snapshots: history.snapshots };
    } else if (mode === 'brawler') {
      const detailResult = await loadPlayerBrawlers({
        tag: resolved.tag,
        guildId: interaction.guildId,
      });
      const topName = [...profile.brawlers].sort((left, right) => right.trophies - left.trophies)[0]?.name;
      const detail =
        detailResult.kind === 'ok' && topName !== undefined
          ? detailResult.value.brawlers.find((brawler) => brawler.name === topName) ?? null
          : null;
      options = { mode, brawlerDetail: detail };
      assets = {
        ...assets,
        allBrawlerPortraitUrls: await resolveModePortraits(profile.brawlers, mode),
      };
    } else if (mode !== 'profile') {
      assets = {
        ...assets,
        allBrawlerPortraitUrls: await resolveModePortraits(profile.brawlers, mode),
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
