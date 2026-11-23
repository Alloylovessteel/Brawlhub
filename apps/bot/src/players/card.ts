import { buildBrawlToolsImage } from '../images/brawltools-style.js';
import type { PlayerBrawler, PlayerBrawlerDetail, PlayerProfileView } from './types';

/**
 * Static image assets passed in by the command layer. URLs come only from the
 * BrawlAPI static metadata resolver; every value shown on the card comes from
 * the official Brawl Stars player profile in `PlayerProfileView`.
 */
export interface PlayerCardAssets {
  readonly playerIconUrl?: string | null;
  readonly clubBadgeUrl?: string | null;
  readonly brawlerPortraitUrls?: readonly (string | null | undefined)[];
  /** Portrait URLs keyed by brawler name, used by grid/rank image modes. */
  readonly allBrawlerPortraitUrls?: Readonly<Record<string, string | null | undefined>>;
  readonly badges?: readonly string[];
}

export const PLAYER_CARD_MODES = [
  'profile',
  'brawler',
  'rank',
  'trophies',
  'highest',
  'season',
  'history',
] as const;

export type PlayerCardMode = (typeof PLAYER_CARD_MODES)[number];

export interface PlayerSeasonWindow {
  readonly start: string | null;
  readonly end: string | null;
}

export interface PlayerHistoryEvent {
  readonly type: 'join' | 'leave' | 'transfer';
  readonly label: string;
  readonly date: string | null;
}

export interface PlayerHistoryMegaPig {
  readonly date: string | null;
  readonly wins: number | null;
  readonly draws: number | null;
  readonly losses: number | null;
  readonly ticketsUsed: number | null;
}

export interface PlayerHistorySummary {
  readonly points: number;
  readonly firstAt: string | null;
  readonly latestAt: string | null;
  readonly firstTrophies: number | null;
  readonly latestTrophies: number | null;
  readonly clubChanges: number | null;
  readonly nameChanges: number | null;
  readonly events: readonly PlayerHistoryEvent[];
  readonly megaPig: PlayerHistoryMegaPig | null;
}

export interface ModeWinStat {
  readonly label: string;
  readonly wins: number;
  readonly matches: number;
  readonly winRate: number | null;
}

export interface PlayerSnapshotPoint {
  readonly date: string;
  readonly trophies: number | null;
}

export interface PlayerCardCharts {
  readonly trophyChartPng: Buffer | null;
  readonly activityChartPng: Buffer | null;
}

export interface PlayerCardOptions {
  readonly mode?: PlayerCardMode;
  readonly brawlerName?: string | null;
  /** Complete official brawler list for grid modes; falls back to the 8 profile brawlers. */
  readonly brawlers?: readonly PlayerBrawler[];
  readonly brawlerDetail?: PlayerBrawlerDetail | null;
  readonly seasonWindow?: PlayerSeasonWindow;
  readonly history?: PlayerHistorySummary | null;
  readonly modeStats?: readonly ModeWinStat[];
  readonly snapshots?: readonly PlayerSnapshotPoint[];
  readonly charts?: PlayerCardCharts | null;
}

/** Brawlers featured on the top-brawler asset list, highest trophies first. */
export function selectTopBrawlers(profile: PlayerProfileView): readonly PlayerBrawler[] {
  return [...profile.brawlers]
    .sort((left, right) => right.trophies - left.trophies)
    .slice(0, 3);
}

/**
 * Render one of the BrawlTools-style `/me image` presets as PNG bytes.
 * All layouts now live in the dedicated BrawlTools-style renderer.
 */
export async function buildPlayerCardImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets = {},
  options: PlayerCardOptions = {},
): Promise<Buffer> {
  return buildBrawlToolsImage(
    options.mode ?? 'profile',
    profile,
    assets,
    options,
    options.charts ?? null,
  );
}
