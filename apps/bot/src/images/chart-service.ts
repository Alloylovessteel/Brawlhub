import { createHash } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { loadHistoryView } from '../clubs/service.js';
import type { HistoryPeriod } from '../clubs/types.js';
import { cleanTag } from '../discord/format.js';
import { loadPlayerBattles, loadPlayerHistory } from '../players/service.js';
import {
  renderChart,
  type ChartDatum,
  type ChartModel,
  type ChartOption,
  type ChartStat,
} from './chart-render.js';

/**
 * Stored-data chart loader. It never calls the official Brawl Stars API: every
 * value comes from synced snapshots/battles, and rendered PNGs are cached in a
 * guild-scoped table.
 */

const logger = createLogger('bot');
const RENDER_VERSION = 'stored-chart-2026-11-23-light-v1';
const DEFAULT_PERIOD: HistoryPeriod = '30d';

type Db = ReturnType<typeof createTrustedClient>;

export type ChartImageKind = 'player' | 'club';

export type ChartFailure =
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'not-found'; readonly tag: string }
  | { readonly kind: 'unregistered'; readonly tag: string }
  | { readonly kind: 'no-default' }
  | { readonly kind: 'no-data' };

export interface GeneratedChartImage {
  readonly png: Buffer;
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
}

export type ChartImageResult =
  | { readonly kind: 'ok'; readonly image: GeneratedChartImage }
  | { readonly kind: 'failure'; readonly failure: ChartFailure };

export interface LoadOrRenderChartInput {
  readonly guildId: string;
  readonly kind: ChartImageKind;
  readonly tag: string;
  readonly option: ChartOption;
  readonly period?: HistoryPeriod | undefined;
  readonly now?: Date | undefined;
  /** Injected for isolated tests. */
  readonly db?: Db | undefined;
}

interface CacheRow {
  readonly png_base64: string;
  readonly expires_at: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function labelForDate(value: string, monthly: boolean): string {
  const parsed = Date.parse(value);
  const iso = Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  return monthly ? iso.slice(0, 7) : iso.slice(0, 10);
}

function countByDate(
  values: readonly string[],
  monthly: boolean,
): readonly ChartDatum[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = labelForDate(value, monthly);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => ({ label, value }));
}

function snapshotSeries(
  points: readonly { readonly capturedAt: string; readonly trophies: number | null }[],
): readonly ChartDatum[] {
  return points.flatMap((point) => {
    const value = finiteNumber(point.trophies);
    return value === null ? [] : [{ label: labelForDate(point.capturedAt, false), value }];
  });
}

function stat(label: string, value: number | string | null): ChartStat | null {
  if (value === null) return null;
  return { label, value: typeof value === 'number' ? value.toLocaleString('en-US') : value };
}

function compactStats(values: readonly (ChartStat | null)[]): readonly ChartStat[] {
  return values.filter((value): value is ChartStat => value !== null).slice(0, 4);
}

function periodLabel(period: HistoryPeriod): string {
  switch (period) {
    case '7d':
      return 'last 7 days';
    case '30d':
      return 'last 30 days';
    case '90d':
      return 'last 90 days';
    case 'all':
      return 'all stored history';
  }
}

function playerFailure(
  result: { readonly kind: string; readonly tag?: string },
): ChartFailure {
  if (result.kind === 'invalid-tag') return { kind: 'invalid-tag' };
  if (result.kind === 'no-default') return { kind: 'no-default' };
  return { kind: 'not-found', tag: result.tag ?? '' };
}

function clubFailure(result: { readonly kind: string; readonly tag?: string }): ChartFailure {
  if (result.kind === 'invalid-tag') return { kind: 'invalid-tag' };
  if (result.kind === 'no-default') return { kind: 'no-default' };
  return { kind: 'unregistered', tag: result.tag ?? '' };
}

async function buildPlayerModel(
  input: LoadOrRenderChartInput,
  period: HistoryPeriod,
  now: Date,
): Promise<
  | { model: ChartModel; fingerprint: string; clubId: null }
  | { failure: ChartFailure; clubId: null }
> {
  const playerReadOptions = input.db === undefined ? {} : { db: input.db };
  const history = await loadPlayerHistory(
    { tag: input.tag, period, guildId: input.guildId, now },
    playerReadOptions,
  );
  if (history.kind !== 'ok') {
    return { failure: playerFailure(history), clubId: null };
  }

  const battles = await loadPlayerBattles(
    { tag: input.tag, period, guildId: input.guildId, now },
    playerReadOptions,
  );
  const battleView = battles.kind === 'ok' ? battles.value : null;
  const player = history.value.player;
  const subject = `#${cleanTag(player.tag)}`;
  const storedRange = periodLabel(period);
  const subtitle = `Stored player data · ${storedRange} · ${player.name}`;
  const wins = battleView?.wins ?? 0;
  const losses = battleView?.losses ?? 0;
  const draws = battleView?.draws ?? 0;
  const battleCount = battleView?.battles.length ?? 0;
  if (history.value.points.length === 0 && battleCount === 0) {
    return { failure: { kind: 'no-data' }, clubId: null };
  }

  let series: readonly ChartDatum[] = [];
  switch (input.option) {
    case 'trophies':
      series = snapshotSeries(history.value.points);
      break;
    case 'mastery':
      series = [
        { label: 'Prestige', value: player.totalPrestigeLevel ?? 0 },
        { label: 'Peak trophies', value: player.highestTrophies ?? 0 },
        { label: 'Fame', value: player.fame ?? 0 },
      ];
      break;
    case 'fame':
      series = [
        { label: 'Fame', value: player.fame ?? 0 },
        { label: 'Ranked Elo', value: player.rankedElo ?? 0 },
      ];
      break;
    case 'record':
      series = [
        { label: 'Wins', value: wins },
        { label: 'Losses', value: losses },
        { label: 'Draws', value: draws },
      ];
      break;
    case 'activity':
      series = countByDate(
        (battleView?.battles ?? []).map((battle) => battle.battleTime),
        false,
      );
      break;
    case 'monthly_activity':
      series = countByDate(
        (battleView?.battles ?? []).map((battle) => battle.battleTime),
        true,
      );
      break;
    case 'vs_wins':
      series = [{ label: '3vs3 wins', value: player.threeVsThreeVictories ?? 0 }];
      break;
    case 'solo_wins':
      series = [{ label: 'Solo wins', value: player.soloVictories ?? 0 }];
      break;
    case 'duo_wins':
      series = [{ label: 'Duo wins', value: player.duoVictories ?? 0 }];
      break;
  }

  const stats = compactStats([
    stat('Trophies', player.trophies ?? history.value.currentTrophies),
    stat('Peak', player.highestTrophies ?? history.value.highestRecordedTrophies),
    stat('Battles', battleCount),
    stat('Wins', battleView === null ? null : wins),
  ]);

  const model: ChartModel = {
    kind: 'player',
    subject,
    title: `${player.name} · ${input.option.replaceAll('_', ' ')}`,
    subtitle,
    option: input.option,
    series,
    stats,
    footer: 'Stored snapshots and battle logs only · no official API call at command time',
  };
  const fingerprint = hash(
    JSON.stringify({
      model,
      latestSnapshotAt: history.value.latestSnapshotAt,
      lastSyncedAt: player.lastSyncedAt,
      latestBattleAt: battleView?.latestBattleAt ?? player.lastBattleAt,
      snapshotCount: history.value.points.length,
      battleCount,
    }),
  );
  return { model, fingerprint, clubId: null };
}

async function buildClubModel(
  input: LoadOrRenderChartInput,
  period: HistoryPeriod,
  now: Date,
): Promise<
  | { model: ChartModel; fingerprint: string; clubId: string }
  | { failure: ChartFailure; clubId: null }
> {
  const clubReadOptions = input.db === undefined ? {} : { db: input.db };
  const result = await loadHistoryView(
    { tag: input.tag, guildId: input.guildId, period, now },
    clubReadOptions,
  );
  if (result.kind !== 'ok') return { failure: clubFailure(result), clubId: null };

  const view = result.value;
  if (view.points.length === 0) return { failure: { kind: 'no-data' }, clubId: null };
  const subject = `#${cleanTag(view.club.tag)}`;
  const storedRange = periodLabel(period);
  let series: readonly ChartDatum[] = [];

  switch (input.option) {
    case 'trophies':
    case 'fame':
      series = snapshotSeries(view.points);
      break;
    case 'mastery':
    case 'record':
      series = view.points.flatMap((point) => {
        const value = finiteNumber(point.averageTrophies);
        return value === null
          ? []
          : [{ label: labelForDate(point.capturedAt, false), value: Math.round(value) }];
      });
      break;
    case 'activity':
    case 'monthly_activity':
      series = view.points.flatMap((point) => {
        const value = finiteNumber(point.memberCount);
        return value === null
          ? []
          : [{ label: labelForDate(point.capturedAt, input.option === 'monthly_activity'), value }];
      });
      break;
    case 'vs_wins':
    case 'solo_wins':
    case 'duo_wins':
      series = view.points.flatMap((point) => {
        const value = finiteNumber(point.trophies);
        return value === null
          ? []
          : [{ label: labelForDate(point.capturedAt, false), value }];
      });
      break;
  }

  const stats = compactStats([
    stat('Trophies', view.club.trophies),
    stat('Members', view.club.memberCount),
    stat('Change', view.change?.trophies ?? null),
    stat('Snapshots', view.points.length),
  ]);
  const model: ChartModel = {
    kind: 'club',
    subject,
    title: `${view.club.name} · ${input.option.replaceAll('_', ' ')}`,
    subtitle: `Stored club data · ${storedRange} · ${subject}`,
    option: input.option,
    series,
    stats,
    footer: 'Stored club snapshots only · no official API call at command time',
  };
  const fingerprint = hash(
    JSON.stringify({
      model,
      latestSnapshotAt: view.latestSnapshotAt,
      latestSyncAt: view.latestSyncAt,
      snapshotCount: view.points.length,
    }),
  );
  return { model, fingerprint, clubId: view.club.id };
}

function cacheExpired(row: CacheRow, nowMs: number): boolean {
  if (row.expires_at === null) return false;
  const expiresMs = Date.parse(row.expires_at);
  return !Number.isNaN(expiresMs) && expiresMs <= nowMs;
}

async function readCachedImage(
  db: Db,
  input: LoadOrRenderChartInput,
  optionsHash: string,
  sourceFingerprint: string,
  clubId: string | null,
  nowMs: number,
): Promise<GeneratedChartImage | null> {
  let query = db
    .from('generated_images')
    .select('png_base64, expires_at, width, height')
    .eq('guild_id', input.guildId)
    .eq('kind', input.kind)
    .eq('subject_tag', cleanTag(input.tag))
    .eq('options_hash', optionsHash)
    .eq('source_fingerprint', sourceFingerprint)
    .eq('render_version', RENDER_VERSION);
  query = clubId === null ? query.is('club_id', null) : query.eq('club_id', clubId);
  const { data, error } = await query.limit(1);
  if (error !== null && error !== undefined) {
    logger.warn('Could not read chart image cache', { guildId: input.guildId, reason: error.message });
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : undefined) as CacheRow | null | undefined;
  if (row == null || typeof row.png_base64 !== 'string' || cacheExpired(row, nowMs)) return null;
  return {
    png: Buffer.from(row.png_base64, 'base64'),
    fileName: chartFileName(input, nowMs),
    width: finiteNumber(row.width) ?? 1200,
    height: finiteNumber(row.height) ?? 700,
  };
}

function chartFileName(input: LoadOrRenderChartInput, nowMs: number): string {
  const subject = cleanTag(input.tag) || input.kind;
  return `brawlhub-${input.kind}-${subject}-${input.option}-${new Date(nowMs).toISOString().slice(0, 10)}.png`;
}

async function writeCachedImage(
  db: Db,
  input: LoadOrRenderChartInput,
  optionsHash: string,
  sourceFingerprint: string,
  clubId: string | null,
  image: GeneratedChartImage,
): Promise<void> {
  const { error } = await db.from('generated_images').insert({
    guild_id: input.guildId,
    kind: input.kind,
    subject_tag: cleanTag(input.tag),
    club_id: clubId,
    options_hash: optionsHash,
    source_fingerprint: sourceFingerprint,
    render_version: RENDER_VERSION,
    png_base64: image.png.toString('base64'),
    content_type: 'image/png',
    width: image.width,
    height: image.height,
  });
  if (error) {
    logger.warn('Could not cache generated chart image', {
      guildId: input.guildId,
      reason: error.message,
    });
  }
}

/** Build (or reuse) a guild-scoped PNG chart from stored data only. */
export async function loadOrRenderChart(input: LoadOrRenderChartInput): Promise<ChartImageResult> {
  const db = input.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const period = input.period ?? DEFAULT_PERIOD;
  const optionsHash = hash(
    JSON.stringify({ kind: input.kind, option: input.option, period, renderVersion: RENDER_VERSION }),
  );

  const built =
    input.kind === 'player'
      ? await buildPlayerModel(input, period, now)
      : await buildClubModel(input, period, now);
  if ('failure' in built) return { kind: 'failure', failure: built.failure };

  const cached = await readCachedImage(
    db,
    input,
    optionsHash,
    built.fingerprint,
    built.clubId,
    now.getTime(),
  );
  if (cached !== null) return { kind: 'ok', image: cached };

  const rendered = await renderChart(built.model);
  const image: GeneratedChartImage = {
    png: rendered.png,
    fileName: chartFileName(input, now.getTime()),
    width: rendered.width,
    height: rendered.height,
  };
  await writeCachedImage(
    db,
    input,
    optionsHash,
    built.fingerprint,
    built.clubId,
    image,
  );
  return { kind: 'ok', image };
}

/** User-facing messages for stored chart lookup failures. */
export function chartFailureMessage(failure: ChartFailure): string {
  switch (failure.kind) {
    case 'invalid-tag':
      return 'That tag is not valid.';
    case 'not-found':
      return `Player #${failure.tag} is not available in this server's stored data.`;
    case 'unregistered':
      return `Club #${failure.tag} is not registered in this server.`;
    case 'no-default':
      return 'There is no default club in this server. Pass a club tag.';
    case 'no-data':
      return 'No stored chart data yet for this selection — syncs populate these charts.';
  }
}
