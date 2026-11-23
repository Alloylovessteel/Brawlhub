import {
  BrawlStarsApiError,
  getSharedBrawlStarsClient,
  playerBrawlerSchema,
  type BrawlStarsClient,
  type Player,
} from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { brawlTagSchema } from '@brawlhub/shared';
import {
  asNumber,
  asString,
  classifyApiError,
  parseSyncRunRow,
  playerSnapshotAsClubSnapshot,
  readCompletedRunsForIds,
  record,
  relationRecord,
  requireOk,
} from '../clubs/service';
import type { ApiIssue, ClubSnapshot, HistoryPeriod } from '../clubs/types';
import {
  classifyMembershipStatus,
  filterPlayerSnapshots,
  HISTORY_PERIOD_DAYS,
  highestRecordedTrophies,
  isRecentSync,
  membershipDurationMs,
  playerProgression,
  sharedCompletedRunId,
  snapshotWindowsDiffer,
  summarizePlayerBattles,
  toHistoryPoints,
} from './calculate';
import { loadBrawlerCatalog } from './catalog.js';
import type {
  BrawlerAccessoryView,
  BrawlerFilter,
  BrawlerSort,
  OfficialBrawlerRef,
  PlayerBattleHistoryView,
  PlayerBattleRecord,
  PlayerBrawlerDetail,
  PlayerBrawlersView,
  PlayerClubRef,
  PlayerComparisonSide,
  PlayerComparisonView,
  PlayerHistoryPoint,
  PlayerHistoryView,
  PlayerIdentity,
  PlayerClubsView,
  PlayerMembershipEvent,
  PlayerMembershipRecord,
  PlayerProfileView,
  ResolvedPlayerResult,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const PLAYER_API_CACHE_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAYER_COLUMNS = [
  'id',
  'tag',
  'name',
  'trophies',
  'highest_trophies',
  'exp_level',
  'exp_points',
  'last_synced_at',
  'last_battle_at',
  'fame',
  'fame_tier_name',
  'total_prestige_level',
  'three_vs_three_victories',
  'solo_victories',
  'duo_victories',
  'best_robo_rumble_time',
  'best_time_as_big_brawler',
  'ranked_rank_name',
  'ranked_elo',
  'highest_season_ranked_rank_name',
  'highest_season_ranked_elo',
  'highest_all_time_ranked_rank_name',
  'highest_all_time_ranked_elo',
  'is_qualified_from_championship_challenge',
  'profile_extra',
].join(', ');

const PLAYER_SNAPSHOT_COLUMNS =
  'id, player_id, sync_run_id, captured_at, trophies';

const PLAYER_BATTLE_COLUMNS =
  'id, sync_run_id, battle_time, mode, map, battle_type, result, trophy_change, raw';

const MEMBERSHIP_SELECT =
  'id, club_id, player_id, role, valid_from, valid_to, ' +
  'club:clubs!club_memberships_club_id_fkey(id, tag, name)';

const EVENT_SELECT =
  'id, event_type, detected_at, ' +
  'from_club:clubs!membership_events_from_club_id_fkey(id, tag, name), ' +
  'to_club:clubs!membership_events_to_club_id_fkey(id, tag, name)';

const playerApiCache = new Map<string, { expiresAt: number; profile: Player }>();

/** Clear the in-process live player profile cache. Useful after credential changes. */
export function clearPlayerApiCache(): void {
  playerApiCache.clear();
}

interface NormalizedTag {
  readonly ok: boolean;
  readonly tag?: string;
}

function normalizePlayerTag(tag: string): NormalizedTag {
  const parsed = brawlTagSchema.safeParse(tag.trim());
  return parsed.success ? { ok: true, tag: parsed.data } : { ok: false };
}

/** Escape ILIKE wildcards before composing a safe stored-player search. */
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_,]/g, (character) => `\\${character}`);
}

function storedPlayerId(player: PlayerIdentity): string {
  if (player.id === null) {
    throw new Error('Stored player is missing an id');
  }
  return player.id;
}

function isNotFound(error: unknown): boolean {
  return error instanceof BrawlStarsApiError && error.status === 404;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberOrNullFromExtra(extra: unknown, key: string): number | null {
  const source = record(extra);
  if (source === null) return null;
  return asNumber(source[key]);
}

function stringOrNullFromExtra(extra: unknown, key: string): string | null {
  const source = record(extra);
  if (source === null) return null;
  return asString(source[key]);
}

function parseMegaPig(extra: unknown): PlayerIdentity['megaPig'] {
  const source = record(extra);
  const raw = record(source?.['megaPig']);
  if (raw === null) return null;
  const date = asString(raw['date']) ?? asString(raw['week']);
  const wins = asNumber(raw['wins']);
  const draws = asNumber(raw['draws']);
  const losses = asNumber(raw['losses']);
  const ticketsUsed = asNumber(raw['ticketsUsed']) ?? asNumber(raw['tickets']);
  if (
    date === null &&
    wins === null &&
    draws === null &&
    losses === null &&
    ticketsUsed === null
  ) {
    return null;
  }
  return { date, wins, draws, losses, ticketsUsed };
}

export function parsePlayerRow(value: unknown): PlayerIdentity | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const parsedTag = brawlTagSchema.safeParse(row['tag'] ?? '');
  const name = asString(row['name']);
  if (id === null || !parsedTag.success || name === null) return null;

  const extra = row['profile_extra'];

  return {
    id,
    tag: parsedTag.data,
    name,
    trophies: asNumber(row['trophies']),
    highestTrophies: asNumber(row['highest_trophies']),
    expLevel: asNumber(row['exp_level']),
    expPoints: asNumber(row['exp_points']) ?? numberOrNullFromExtra(extra, 'expPoints'),
    iconId: asNumber(row['icon_id']) ?? asNumber(record(record(extra)?.['icon'])?.['id']),
    lastSyncedAt: asString(row['last_synced_at']),
    lastBattleAt: asString(row['last_battle_at']),
    fame: asNumber(row['fame']) ?? numberOrNullFromExtra(extra, 'fame'),
    fameTierName: asString(row['fame_tier_name']) ?? stringOrNullFromExtra(extra, 'fameTierName'),
    totalPrestigeLevel: asNumber(row['total_prestige_level']) ?? numberOrNullFromExtra(extra, 'totalPrestigeLevel'),
    threeVsThreeVictories: asNumber(row['three_vs_three_victories']) ?? numberOrNullFromExtra(extra, '3vs3Victories'),
    soloVictories: asNumber(row['solo_victories']) ?? numberOrNullFromExtra(extra, 'soloVictories'),
    duoVictories: asNumber(row['duo_victories']) ?? numberOrNullFromExtra(extra, 'duoVictories'),
    bestRoboRumbleTime: asNumber(row['best_robo_rumble_time']) ?? numberOrNullFromExtra(extra, 'bestRoboRumbleTime'),
    bestTimeAsBigBrawler: asNumber(row['best_time_as_big_brawler']) ?? numberOrNullFromExtra(extra, 'bestTimeAsBigBrawler'),
    rankedRankName: asString(row['ranked_rank_name']) ?? stringOrNullFromExtra(extra, 'rankedRankName'),
    rankedElo: asNumber(row['ranked_elo']) ?? numberOrNullFromExtra(extra, 'rankedElo'),
    highestSeasonRankedRankName: asString(row['highest_season_ranked_rank_name']) ?? stringOrNullFromExtra(extra, 'highestSeasonRankedRankName'),
    highestSeasonRankedElo: asNumber(row['highest_season_ranked_elo']) ?? numberOrNullFromExtra(extra, 'highestSeasonRankedElo'),
    highestAllTimeRankedRankName: asString(row['highest_all_time_ranked_rank_name']) ?? stringOrNullFromExtra(extra, 'highestAllTimeRankedRankName'),
    highestAllTimeRankedElo: asNumber(row['highest_all_time_ranked_elo']) ?? numberOrNullFromExtra(extra, 'highestAllTimeRankedElo'),
    isQualifiedFromChampionshipChallenge:
      asBoolean(row['is_qualified_from_championship_challenge']) ??
      (typeof record(extra)?.['isQualifiedFromChampionshipChallenge'] === 'boolean'
        ? (record(extra)?.['isQualifiedFromChampionshipChallenge'] as boolean)
        : null),
    megaPig: parseMegaPig(extra),
  };
}

export const BRAWLER_SORTS = ['trophies', 'highest', 'power', 'rank', 'name'] as const;
export const BRAWLER_FILTERS = ['all', 'maxed', 'ranked', 'unowned'] as const;

export function isBrawlerSort(value: string): value is BrawlerSort {
  return (BRAWLER_SORTS as readonly string[]).includes(value);
}

export function isBrawlerFilter(value: string): value is BrawlerFilter {
  return (BRAWLER_FILTERS as readonly string[]).includes(value);
}

function normalizeBrawlerName(name: string): string {
  return name.trim().toLowerCase();
}

function parseBrawlerAccessories(value: unknown): readonly BrawlerAccessoryView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      id: asNumber(item['id']),
      name: asString(item['name']),
      level: asNumber(item['level']),
    }));
}

function parseBrawlerDetail(value: unknown): PlayerBrawlerDetail | null {
  const parsed = playerBrawlerSchema.safeParse(value);
  if (!parsed.success) return null;
  const brawler = parsed.data;
  return {
    id: brawler.id ?? null,
    name: brawler.name.trim(),
    trophies: brawler.trophies,
    highestTrophies: brawler.highestTrophies ?? null,
    power: brawler.power ?? null,
    rank: brawler.rank ?? null,
    prestigeLevel: brawler.prestigeLevel ?? null,
    currentWinStreak: brawler.currentWinStreak ?? null,
    maxWinStreak: brawler.maxWinStreak ?? null,
    gadgets: parseBrawlerAccessories(brawler.gadgets),
    starPowers: parseBrawlerAccessories(brawler.starPowers),
    gears: parseBrawlerAccessories(brawler.gears),
    hyperCharges: parseBrawlerAccessories(brawler.hyperCharges),
  };
}

/** Parse an official player brawler array, dropping malformed and duplicate entries. */
function parseBrawlerList(value: unknown): readonly PlayerBrawlerDetail[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map(parseBrawlerDetail)
    .filter((brawler): brawler is PlayerBrawlerDetail => brawler !== null)
    .filter((brawler) => {
      const key = normalizeBrawlerName(brawler.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Parse the full official brawler array stored in `players.profile_extra`. */
export function parseStoredBrawlers(extra: unknown): readonly PlayerBrawlerDetail[] {
  return parseBrawlerList(record(extra)?.['brawlers']);
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
  descending: boolean,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return descending ? right - left : left - right;
}

/** Sort full brawler details with missing values last. */
export function sortPlayerBrawlers(
  brawlers: readonly PlayerBrawlerDetail[],
  sort: BrawlerSort,
): readonly PlayerBrawlerDetail[] {
  return [...brawlers].sort((a, b) => {
    switch (sort) {
      case 'highest':
        return compareNullableNumber(a.highestTrophies, b.highestTrophies, true);
      case 'power':
        return compareNullableNumber(a.power, b.power, true);
      case 'rank':
        return compareNullableNumber(a.rank, b.rank, true);
      case 'name':
        return a.name.localeCompare(b.name);
      case 'trophies':
      default:
        return compareNullableNumber(a.trophies, b.trophies, true);
    }
  });
}

function catalogBrawlerDetail(ref: OfficialBrawlerRef): PlayerBrawlerDetail {
  return {
    id: ref.id,
    name: ref.name,
    trophies: null,
    highestTrophies: null,
    power: null,
    rank: null,
    prestigeLevel: null,
    currentWinStreak: null,
    maxWinStreak: null,
    gadgets: [],
    starPowers: [],
    gears: [],
    hyperCharges: [],
  };
}

/** Filter brawler details. `unowned` uses the official catalog, not invented data. */
export function filterPlayerBrawlers(
  brawlers: readonly PlayerBrawlerDetail[],
  filter: BrawlerFilter,
  catalog: readonly OfficialBrawlerRef[],
): readonly PlayerBrawlerDetail[] {
  switch (filter) {
    case 'maxed':
      return brawlers.filter((brawler) => (brawler.power ?? 0) >= 11);
    case 'ranked':
      return brawlers.filter((brawler) => (brawler.rank ?? 0) > 0);
    case 'unowned': {
      const profileNames = new Set(brawlers.map((brawler) => normalizeBrawlerName(brawler.name)));
      return catalog
        .filter((ref) => !profileNames.has(normalizeBrawlerName(ref.name)))
        .map(catalogBrawlerDetail);
    }
    case 'all':
    default:
      return brawlers;
  }
}

function parseClubRef(value: unknown, fallbackTag?: string): PlayerClubRef | null {
  const source = relationRecord(value) ?? record(value);
  if (source === null) return null;
  const parsedTag = brawlTagSchema.safeParse(source['tag'] ?? fallbackTag ?? '');
  const name = asString(source['name']);
  if (!parsedTag.success || name === null) return null;

  return {
    id: asString(source['id']),
    tag: parsedTag.data,
    name,
    role: asString(source['role']),
    validFrom: asString(source['valid_from']),
    validTo: asString(source['valid_to']),
  };
}

export function parseMembershipRow(value: unknown, staleAfterMs: number, now: Date, playerSyncedAt: string | null): PlayerMembershipRecord | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const club = parseClubRef(row['club']);
  if (id === null || club === null) return null;
  const validFrom = asString(row['valid_from']);
  const validTo = asString(row['valid_to']);

  return {
    ...club,
    id,
    role: asString(row['role']),
    validFrom,
    validTo,
    status: classifyMembershipStatus(validFrom, validTo, playerSyncedAt, now, staleAfterMs),
    durationMs: membershipDurationMs(validFrom, validTo),
  };
}

function parseMembershipEventRow(value: unknown): PlayerMembershipEvent | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const eventType = asString(row['event_type']);
  const detectedAt = asString(row['detected_at']);
  if (
    id === null ||
    detectedAt === null ||
    (eventType !== 'join' && eventType !== 'leave' && eventType !== 'transfer')
  ) {
    return null;
  }

  return {
    id,
    eventType,
    detectedAt,
    fromClub: parseClubRef(row['from_club']),
    toClub: parseClubRef(row['to_club']),
  };
}

function selectCurrentClub(
  memberships: readonly PlayerMembershipRecord[],
): PlayerClubRef | null {
  return (
    memberships.find((membership) => membership.status === 'current') ??
    memberships.find((membership) => membership.status === 'last-recorded') ??
    null
  );
}

function latestSnapshot(snapshots: readonly ClubSnapshot[]): ClubSnapshot | null {
  return snapshots.reduce<ClubSnapshot | null>((latest, candidate) => {
    if (latest === null) return candidate;
    return Date.parse(candidate.capturedAt) > Date.parse(latest.capturedAt) ? candidate : latest;
  }, null);
}

function snapshotForRun(
  snapshots: readonly ClubSnapshot[],
  runId: string | null,
): ClubSnapshot | null {
  if (runId === null) return latestSnapshot(snapshots);
  return snapshots.find((snapshot) => snapshot.syncRunId === runId) ?? null;
}

function withinPeriod(
  timestamp: string | null,
  period: HistoryPeriod,
  now: Date,
): boolean {
  if (timestamp === null) return false;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  const days = HISTORY_PERIOD_DAYS[period];
  return days === null || parsed >= now.getTime() - days * DAY_MS;
}

async function readPlayerByTag(tag: string, db: DatabaseClient): Promise<PlayerIdentity | null> {
  const { data, error } = await db
    .from('players')
    .select(PLAYER_COLUMNS)
    .eq('tag', tag)
    .maybeSingle();
  requireOk(error, 'Read player');
  return data === null || data === undefined ? null : parsePlayerRow(data);
}

async function readPlayerProfileExtra(tag: string, db: DatabaseClient): Promise<unknown> {
  const { data, error } = await db
    .from('players')
    .select('profile_extra')
    .eq('tag', tag)
    .maybeSingle();
  requireOk(error, 'Read stored player details');
  return record(data)?.['profile_extra'] ?? null;
}

export interface PlayerSearchOptions {
  readonly db?: DatabaseClient;
  readonly guildId?: string | null;
}

/** Missing guild context is not a global pass: it resolves to an empty scope. */
async function readGuildClubIds(guildId: string | null | undefined, db: DatabaseClient): Promise<string[]> {
  if (guildId === undefined || guildId === null || guildId.trim() === '') return [];
  const { data, error } = await db
    .from('clubs')
    .select('id')
    .eq('guild_id', guildId.trim())
    .is('archived_at', null);
  requireOk(error, 'Read guild clubs');
  return (data ?? [])
    .map((row: unknown) => asString(record(row)?.['id']))
    .filter((id): id is string => id !== null);
}

async function readPlayerIdsInClubs(clubIds: readonly string[], db: DatabaseClient): Promise<Set<string>> {
  if (clubIds.length === 0) return new Set();
  const { data, error } = await db
    .from('club_memberships')
    .select('player_id')
    .in('club_id', [...new Set(clubIds)]);
  requireOk(error, 'Read guild members');
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const playerId = asString(record(row)?.['player_id']);
    if (playerId !== null) ids.add(playerId);
  }
  return ids;
}

/** True when a stored player belongs to one of the guild's active registered clubs. */
async function isPlayerInGuildScope(
  player: PlayerIdentity,
  guildId: string | null | undefined,
  db: DatabaseClient,
  knownClubIds?: readonly string[] | null,
): Promise<boolean> {
  const guildClubIds = knownClubIds !== undefined
    ? knownClubIds
    : await readGuildClubIds(guildId, db);
  if (guildClubIds === null) return false;
  if (player.id === null || guildClubIds.length === 0) return false;
  const allowed = await readPlayerIdsInClubs(guildClubIds, db);
  return allowed.has(player.id);
}

/** Read a stored player only when it is visible inside the invoking guild. */
async function readGuildScopedPlayer(
  tag: string,
  guildId: string | null | undefined,
  db: DatabaseClient,
  guildClubIds?: readonly string[] | null,
): Promise<PlayerIdentity | null> {
  const player = await readPlayerByTag(tag, db);
  if (player === null) return null;
  return (await isPlayerInGuildScope(player, guildId, db, guildClubIds)) ? player : null;
}

export async function searchPlayers(
  query: string,
  dbOrOptions: DatabaseClient | PlayerSearchOptions = createTrustedClient(),
): Promise<PlayerIdentity[]> {
  const isDb =
    typeof (dbOrOptions as { from?: unknown }).from === 'function';
  const db = isDb
    ? (dbOrOptions as DatabaseClient)
    : ((dbOrOptions as PlayerSearchOptions).db ?? createTrustedClient());
  const guildId = isDb ? null : (dbOrOptions as PlayerSearchOptions).guildId;

  const cleaned = query.trim().replace(/^#+/, '');
  const escaped = escapeIlike(cleaned);

  // Guild visibility must be applied before the row cap: otherwise 25 earlier
  // matches from other guilds can hide every player this guild can actually see.
  const guildClubIds = await readGuildClubIds(guildId, db);
  if (guildClubIds.length === 0) return [];
  const allowedPlayerIds = [...await readPlayerIdsInClubs(guildClubIds, db)];
  if (allowedPlayerIds.length === 0) return [];

  let builder = db
    .from('players')
    .select(PLAYER_COLUMNS)
    .in('id', allowedPlayerIds)
    .order('name', { ascending: true })
    .limit(25);
  if (escaped !== '') {
    builder = builder.or(`tag.ilike.%${escaped}%,name.ilike.%${escaped}%`);
  }

  const { data, error } = await builder;
  requireOk(error, 'Search players');
  return (data ?? [])
    .map((row: unknown) => parsePlayerRow(row))
    .filter((row): row is PlayerIdentity => row !== null);
}

async function readCompletedSnapshots(
  playerId: string,
  db: DatabaseClient,
): Promise<{ snapshots: ClubSnapshot[]; completedRunIds: Set<string> }> {
  // Newest first, and no row cap: status is resolved only for the runs that
  // actually produced these snapshots, so an old run can never be dropped by a
  // global "recent completed runs" window.
  const { data, error } = await db
    .from('player_snapshots')
    .select(PLAYER_SNAPSHOT_COLUMNS)
    .eq('player_id', playerId)
    .order('captured_at', { ascending: false });
  requireOk(error, 'Read player history');

  const all = (data ?? [])
    .map((row: unknown) => playerSnapshotAsClubSnapshot(row))
    .filter((snapshot): snapshot is ClubSnapshot => snapshot !== null);
  const completedRunIds = new Set(
    (await readCompletedRunsForIds(all.map((snapshot) => snapshot.syncRunId), db)).map(
      (run) => run.id,
    ),
  );
  return {
    snapshots: all.filter((snapshot) => completedRunIds.has(snapshot.syncRunId)),
    completedRunIds,
  };
}

function readBattleExtras(
  rawValue: unknown,
  playerTag: string,
): { readonly brawlerName: string | null; readonly starPlayerName: string | null } {
  const empty = { brawlerName: null, starPlayerName: null };
  if (rawValue === null || typeof rawValue !== 'object') return empty;
  const battle = (rawValue as Record<string, unknown>)['battle'];
  if (battle === null || typeof battle !== 'object') return empty;
  const data = battle as Record<string, unknown>;

  const starPlayer = data['starPlayer'];
  const starPlayerName =
    starPlayer !== null && typeof starPlayer === 'object'
      ? asString((starPlayer as Record<string, unknown>)['name'])
      : null;

  const participants: unknown[] = [];
  if (Array.isArray(data['teams'])) {
    for (const team of data['teams']) {
      if (Array.isArray(team)) participants.push(...team);
    }
  }
  if (Array.isArray(data['players'])) participants.push(...data['players']);

  const wanted = playerTag.replace(/^#+/, '').toUpperCase();
  const mine = participants.find((participant) => {
    if (participant === null || typeof participant !== 'object') return false;
    const tag = asString((participant as Record<string, unknown>)['tag']);
    return tag !== null && tag.replace(/^#+/, '').toUpperCase() === wanted;
  });
  const brawler =
    mine !== undefined && mine !== null && typeof mine === 'object'
      ? (mine as Record<string, unknown>)['brawler']
      : null;
  const brawlerName =
    brawler !== null && typeof brawler === 'object'
      ? asString((brawler as Record<string, unknown>)['name'])
      : null;

  return { brawlerName, starPlayerName };
}

async function readPlayerBattles(
  playerId: string,
  playerTag: string,
  db: DatabaseClient,
  period: HistoryPeriod,
  now: Date,
): Promise<PlayerBattleRecord[]> {
  const days = HISTORY_PERIOD_DAYS[period];
  const sinceMs = days === null ? null : now.getTime() - days * DAY_MS;
  let query = db
    .from('player_battles')
    .select(PLAYER_BATTLE_COLUMNS)
    .eq('player_id', playerId)
    .order('battle_time', { ascending: false });
  // Bound the period in the query so a row cap can never discard in-period
  // battles in favour of newer rows outside the requested window.
  if (sinceMs !== null) query = query.gte('battle_time', new Date(sinceMs).toISOString());
  const { data, error } = await query;
  requireOk(error, 'Read battle history');

  const rows = (data ?? [])
    .map((row: unknown) => {
      const item = record(row);
      const battleTime = asString(item?.['battle_time']);
      if (battleTime === null) return null;
      const syncRunId = asString(item?.['sync_run_id']);
      if (!withinPeriod(battleTime, period, now)) return null;
      const trophyChange = asNumber(item?.['trophy_change']);
      const extras = readBattleExtras(item?.['raw'], playerTag);
      return {
        id: asString(item?.['id']) ?? '',
        syncRunId,
        battleTime,
        mode: asString(item?.['mode']),
        map: asString(item?.['map']),
        battleType: asString(item?.['battle_type']),
        result: asString(item?.['result']),
        trophyChange: trophyChange !== null && Number.isFinite(trophyChange) ? trophyChange : null,
        brawlerName: extras.brawlerName,
        starPlayerName: extras.starPlayerName,
      } satisfies PlayerBattleRecord;
    })
    .filter((battle): battle is PlayerBattleRecord => battle !== null && battle.id !== '');

  const completedRunIds = new Set(
    (await readCompletedRunsForIds(
      rows.flatMap((battle) => (battle.syncRunId === null ? [] : [battle.syncRunId])),
      db,
    )).map((run) => run.id),
  );
  // A null sync_run_id predates run tracking and stays valid; anything with an
  // explicit run id must belong to a completed sync.
  return rows.filter(
    (battle) => battle.syncRunId === null || completedRunIds.has(battle.syncRunId),
  );
}

async function readMemberships(
  playerId: string,
  db: DatabaseClient,
  playerSyncedAt: string | null,
  staleAfterMs: number,
  now: Date,
  guildClubIds?: readonly string[] | null,
): Promise<PlayerMembershipRecord[]> {
  let query = db
    .from('club_memberships')
    .select(MEMBERSHIP_SELECT)
    .eq('player_id', playerId)
    .order('valid_from', { ascending: false })
    .limit(100);
  if (guildClubIds && guildClubIds.length > 0) {
    query = query.in('club_id', [...guildClubIds]);
  } else if (guildClubIds && guildClubIds.length === 0) {
    return [];
  }
  const { data, error } = await query;
  requireOk(error, 'Read club memberships');

  return (data ?? [])
    .map((row: unknown) => parseMembershipRow(row, staleAfterMs, now, playerSyncedAt))
    .filter((row): row is PlayerMembershipRecord => row !== null);
}

async function readEvents(
  playerId: string,
  db: DatabaseClient,
  guildClubIds?: readonly string[] | null,
): Promise<PlayerMembershipEvent[]> {
  const { data, error } = await db
    .from('membership_events')
    .select(EVENT_SELECT)
    .eq('player_id', playerId)
    .order('detected_at', { ascending: false })
    .limit(100);
  requireOk(error, 'Read membership events');

  const events = (data ?? [])
    .map((row: unknown) => parseMembershipEventRow(row))
    .filter((row): row is PlayerMembershipEvent => row !== null);
  if (!guildClubIds) return events;
  const allowed = new Set(guildClubIds);
  return events.filter((event) =>
    (event.fromClub?.id !== null && event.fromClub?.id !== undefined && allowed.has(event.fromClub.id)) ||
    (event.toClub?.id !== null && event.toClub?.id !== undefined && allowed.has(event.toClub.id)),
  );
}

interface LivePlayerFetchResult {
  readonly profile: Player | null;
  readonly issue: ApiIssue | null;
  readonly notFound: boolean;
}

function emptyLiveResult(): LivePlayerFetchResult {
  return { profile: null, issue: null, notFound: false };
}

/** Fetch current player data once per tag for a short TTL, caching successes only. */
async function fetchLivePlayer(
  tag: string,
  api: BrawlStarsClient | undefined,
  now: Date,
  useCache: boolean,
): Promise<LivePlayerFetchResult> {
  const client = api ?? getSharedBrawlStarsClient();
  const cached = useCache ? playerApiCache.get(tag) : undefined;
  if (cached !== undefined && cached.expiresAt > now.getTime()) {
    return { profile: cached.profile, issue: null, notFound: false };
  }

  try {
    const profile = await client.getPlayer(tag);
    const returnedTag = brawlTagSchema.safeParse(profile.tag);
    if (!returnedTag.success || returnedTag.data !== tag) {
      throw new BrawlStarsApiError('Official API returned a mismatched player tag', 0);
    }
    if (useCache) {
      playerApiCache.set(tag, { expiresAt: now.getTime() + PLAYER_API_CACHE_MS, profile });
    }
    return { profile, issue: null, notFound: false };
  } catch (error) {
    return { profile: null, issue: classifyApiError(error), notFound: isNotFound(error) };
  }
}

function identityFromLive(live: Player, stored: PlayerIdentity | null, tag: string): PlayerIdentity {
  const base = stored ?? {
    id: null,
    tag,
    name: live.name,
    trophies: null,
    highestTrophies: null,
    expLevel: null,
    expPoints: null,
    iconId: null,
    lastSyncedAt: null,
    lastBattleAt: null,
    fame: null,
    fameTierName: null,
    totalPrestigeLevel: null,
    threeVsThreeVictories: null,
    soloVictories: null,
    duoVictories: null,
    bestRoboRumbleTime: null,
    bestTimeAsBigBrawler: null,
    rankedRankName: null,
    rankedElo: null,
    highestSeasonRankedRankName: null,
    highestSeasonRankedElo: null,
    highestAllTimeRankedRankName: null,
    highestAllTimeRankedElo: null,
    isQualifiedFromChampionshipChallenge: null,
    megaPig: null,
  };

  const liveMegaPig = parseMegaPig(live as unknown);
  const highest = live.highestTrophies ?? live.highscore ?? base.highestTrophies;
  return {
    ...base,
    tag,
    name: live.name,
    trophies: live.trophies,
    highestTrophies: highest ?? null,
    expLevel: live.expLevel ?? base.expLevel,
    expPoints: live.expPoints ?? base.expPoints,
    iconId: live.icon?.id ?? base.iconId,
    fame: live.fame ?? base.fame,
    fameTierName: live.fameTierName ?? base.fameTierName,
    totalPrestigeLevel: live.totalPrestigeLevel ?? base.totalPrestigeLevel,
    threeVsThreeVictories: live['3vs3Victories'] ?? base.threeVsThreeVictories,
    soloVictories: live.soloVictories ?? base.soloVictories,
    duoVictories: live.duoVictories ?? base.duoVictories,
    bestRoboRumbleTime: live.bestRoboRumbleTime ?? base.bestRoboRumbleTime,
    bestTimeAsBigBrawler: live.bestTimeAsBigBrawler ?? base.bestTimeAsBigBrawler,
    rankedRankName: live.rankedRankName ?? base.rankedRankName,
    rankedElo: live.rankedElo ?? base.rankedElo,
    highestSeasonRankedRankName: live.highestSeasonRankedRankName ?? base.highestSeasonRankedRankName,
    highestSeasonRankedElo: live.highestSeasonRankedElo ?? base.highestSeasonRankedElo,
    highestAllTimeRankedRankName: live.highestAllTimeRankedRankName ?? base.highestAllTimeRankedRankName,
    highestAllTimeRankedElo: live.highestAllTimeRankedElo ?? base.highestAllTimeRankedElo,
    isQualifiedFromChampionshipChallenge:
      typeof live.isQualifiedFromChampionshipChallenge === 'boolean'
        ? live.isQualifiedFromChampionshipChallenge
        : base.isQualifiedFromChampionshipChallenge,
    megaPig: liveMegaPig ?? base.megaPig,
  };
}

function profileFromLive(live: Player, stored: PlayerIdentity | null, tag: string): PlayerIdentity {
  return identityFromLive(live, stored, tag);
}

function liveClubRef(club: Player['club']): PlayerClubRef | null {
  if (club === undefined) return null;
  const parsedTag = brawlTagSchema.safeParse(club.tag);
  if (!parsedTag.success) return null;
  return {
    id: null,
    tag: parsedTag.data,
    name: club.name,
    role: null,
    validFrom: null,
    validTo: null,
  };
}

export interface PlayerServiceOptions {
  readonly db?: DatabaseClient;
  readonly api?: BrawlStarsClient;
  /** Disable the short-lived in-process API cache in tests or one-off scripts. */
  readonly useCache?: boolean;
  /** Stored data older than this is refreshed from the official API. */
  readonly staleAfterMs?: number;
}

export interface PlayerReadOptions {
  readonly db?: DatabaseClient;
  readonly staleAfterMs?: number;
  readonly guildId?: string | null;
}

export interface PlayerHistoryInput {
  readonly tag: string;
  readonly period: HistoryPeriod;
  readonly now?: Date;
  readonly seasonStartIso?: string | undefined;
  readonly guildId?: string | null;
}

/** Load a detailed player profile, refreshing stale data from the official API. */
export async function loadPlayerProfile(
  input: { readonly tag: string; readonly now?: Date; readonly guildId?: string | null },
  options: PlayerServiceOptions = {},
): Promise<ResolvedPlayerResult<PlayerProfileView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const api = options.api ?? getSharedBrawlStarsClient();
  const now = input.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const stored = await readPlayerByTag(normalized.tag, db);
  const storedInScope =
    stored !== null && (await isPlayerInGuildScope(stored, input.guildId, db));
  const needsRefresh =
    !storedInScope || stored === null || !isRecentSync(stored.lastSyncedAt, now, staleAfterMs);
  const live = needsRefresh
    ? await fetchLivePlayer(normalized.tag, api, now, options.useCache ?? true)
    : emptyLiveResult();

  if (!storedInScope && live.profile === null) {
    return live.notFound
      ? { kind: 'not-found', tag: normalized.tag }
      : {
          kind: 'api-unavailable',
          tag: normalized.tag,
          issue: live.issue ?? 'error',
        };
  }

  const scopedStored = storedInScope ? stored : null;
  const effective = live.profile !== null
    ? identityFromLive(live.profile, scopedStored, normalized.tag)
    : scopedStored;
  if (effective === null) return { kind: 'not-found', tag: normalized.tag };

  const guildClubIds = await readGuildClubIds(input.guildId, db);
  const [history, memberships] = scopedStored === null
    ? [{ snapshots: [] as ClubSnapshot[] }, [] as PlayerMembershipRecord[]]
    : await Promise.all([
        readCompletedSnapshots(storedPlayerId(scopedStored), db),
        readMemberships(storedPlayerId(scopedStored), db, scopedStored.lastSyncedAt, staleAfterMs, now, guildClubIds),
      ]);

  const liveBrawlers = live.profile?.brawlers ?? [];
  const brawlers = liveBrawlers
    .map((brawler) => ({
      name: brawler.name,
      trophies: brawler.trophies,
      highestTrophies: brawler.highestTrophies ?? null,
      power: brawler.power ?? null,
      rank: brawler.rank ?? null,
      prestigeLevel: brawler.prestigeLevel ?? null,
      currentWinStreak: brawler.currentWinStreak ?? null,
      maxWinStreak: brawler.maxWinStreak ?? null,
      gadgets: Array.isArray(brawler.gadgets) ? brawler.gadgets.length : 0,
      starPowers: Array.isArray(brawler.starPowers) ? brawler.starPowers.length : 0,
      gears: Array.isArray(brawler.gears) ? brawler.gears.length : 0,
      hyperCharges: Array.isArray(brawler.hyperCharges) ? brawler.hyperCharges.length : 0,
    }))
    .sort((a, b) => b.trophies - a.trophies)
    .slice(0, 8);

  const stats = live.profile !== null
    ? {
        brawlerCount: liveBrawlers.length,
        totalPrestigeLevels: live.profile.totalPrestigeLevel ?? null,
        maxedBrawlers: liveBrawlers.filter((b) => (b.power ?? 0) >= 11).length,
      }
    : null;

  const apiIssue: PlayerProfileView['apiIssue'] = live.notFound
    ? 'not-found'
    : live.issue;

  let currentClub = liveClubRef(live.profile?.club) ?? selectCurrentClub(memberships);
  if (guildClubIds !== null && currentClub !== null) {
    if (!(currentClub.id !== null && guildClubIds.includes(currentClub.id))) {
      const { data: guildClubRows } = await db.from('clubs').select('id, tag').eq('guild_id', input.guildId ?? '').is('archived_at', null).in('id', guildClubIds.length ? guildClubIds : ['00000000-0000-0000-0000-000000000000']);
      const allowedTags = new Set((guildClubRows ?? []).map((row) => asString(record(row)?.['tag'])).filter((t) => t !== null));
      if (!allowedTags.has(currentClub.tag)) currentClub = selectCurrentClub(memberships);
    }
  }

  return {
    kind: 'ok',
    value: {
      player: effective,
      currentClub,
      brawlers,
      stats,
      latestSnapshotAt: latestSnapshot(history.snapshots)?.capturedAt ?? null,
      source: live.profile !== null ? 'live' : 'stored',
      apiIssue,
      profileFetchedAt: live.profile !== null ? now.toISOString() : null,
    },
  };
}

export interface PlayerBrawlersInput {
  readonly tag: string;
  readonly guildId?: string | null;
  readonly now?: Date;
}

/**
 * Load the complete brawler list for one player. The live official player
 * payload is authoritative; `players.profile_extra.brawlers` is only used when
 * the live response is unavailable or has no brawler array.
 */
export async function loadPlayerBrawlers(
  input: PlayerBrawlersInput,
  options: PlayerServiceOptions = {},
): Promise<ResolvedPlayerResult<PlayerBrawlersView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const api = options.api ?? getSharedBrawlStarsClient();
  const now = input.now ?? new Date();
  const useCache = options.useCache ?? true;

  const stored = await readPlayerByTag(normalized.tag, db);
  const storedInScope =
    stored !== null && (await isPlayerInGuildScope(stored, input.guildId, db));
  const scopedStored = storedInScope ? stored : null;

  const [live, catalog] = await Promise.all([
    fetchLivePlayer(normalized.tag, api, now, useCache),
    loadBrawlerCatalog({ api, now, useCache }),
  ]);
  const liveBrawlers = parseBrawlerList(live.profile?.brawlers);

  if (live.profile !== null && liveBrawlers.length > 0) {
    return {
      kind: 'ok',
      value: {
        player: identityFromLive(live.profile, scopedStored, normalized.tag),
        brawlers: sortPlayerBrawlers(liveBrawlers, 'trophies'),
        catalog,
        source: 'live',
        apiIssue: null,
        fetchedAt: now.toISOString(),
      },
    };
  }

  if (scopedStored !== null) {
    const extra = await readPlayerProfileExtra(normalized.tag, db);
    const storedBrawlers = parseStoredBrawlers(extra);
    return {
      kind: 'ok',
      value: {
        player: scopedStored,
        brawlers: sortPlayerBrawlers(storedBrawlers, 'trophies'),
        catalog,
        source: 'stored',
        apiIssue: live.notFound
          ? 'not-found'
          : (live.issue ?? null),
        fetchedAt: null,
      },
    };
  }

  if (live.profile !== null) {
    return {
      kind: 'ok',
      value: {
        player: identityFromLive(live.profile, null, normalized.tag),
        brawlers: [],
        catalog,
        source: 'live',
        apiIssue: null,
        fetchedAt: now.toISOString(),
      },
    };
  }

  return live.notFound
    ? { kind: 'not-found', tag: normalized.tag }
    : {
        kind: 'api-unavailable',
        tag: normalized.tag,
        issue: live.issue ?? 'error',
      };
}

/** Load stored trophy history and any available club-membership context. */
export async function loadPlayerHistory(
  input: PlayerHistoryInput,
  options: PlayerReadOptions = {},
): Promise<ResolvedPlayerResult<PlayerHistoryView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const guildId = input.guildId ?? options.guildId;
  const guildClubIds = await readGuildClubIds(guildId, db);
  const player = await readGuildScopedPlayer(normalized.tag, guildId, db, guildClubIds);
  if (player === null) return { kind: 'not-found', tag: normalized.tag };

  const [{ snapshots }, memberships, events] = await Promise.all([
    readCompletedSnapshots(storedPlayerId(player), db),
    readMemberships(storedPlayerId(player), db, player.lastSyncedAt, staleAfterMs, now, guildClubIds),
    readEvents(storedPlayerId(player), db, guildClubIds),
  ]);
  const periodSnapshots = filterPlayerSnapshots(snapshots, input.period, now);
  const points: PlayerHistoryPoint[] = toHistoryPoints(periodSnapshots);
  const latest = periodSnapshots[periodSnapshots.length - 1] ?? null;
  const currentTrophies = player.trophies ?? latest?.trophies ?? null;
  const currentAt = player.lastSyncedAt ?? latest?.capturedAt ?? null;

  return {
    kind: 'ok',
    value: {
      player,
      period: input.period,
      points,
      currentTrophies,
      highestRecordedTrophies: highestRecordedTrophies(points, player.highestTrophies),
      firstSnapshotAt: points[0]?.capturedAt ?? null,
      latestSnapshotAt: latest?.capturedAt ?? null,
      change: points.length < 2 ? null : { trophies: (() => {
        const first = points[0]?.trophies;
        const last = points[points.length - 1]?.trophies;
        return first !== null && first !== undefined && last !== null && last !== undefined
          ? last - first
          : null;
      })() },
      progression: playerProgression(
        snapshots,
        currentTrophies,
        currentAt,
        now,
        input.seasonStartIso,
      ),
      memberships,
      events: events.filter((event) => withinPeriod(event.detectedAt, input.period, now)),
    },
  };
}

/** Load stored official battle-log history for one guild-visible player. */
export async function loadPlayerBattles(
  input: {
    readonly tag: string;
    readonly period: HistoryPeriod;
    readonly now?: Date;
    readonly guildId?: string | null;
  },
  options: PlayerReadOptions = {},
): Promise<ResolvedPlayerResult<PlayerBattleHistoryView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const guildId = input.guildId ?? options.guildId;
  const guildClubIds = await readGuildClubIds(guildId, db);
  const player = await readGuildScopedPlayer(normalized.tag, guildId, db, guildClubIds);
  if (player === null) return { kind: 'not-found', tag: normalized.tag };

  const battles = await readPlayerBattles(storedPlayerId(player), player.tag, db, input.period, now);
  const summary = summarizePlayerBattles(battles);
  return {
    kind: 'ok',
    value: {
      player,
      period: input.period,
      battles,
      ...summary,
      firstBattleAt: battles[battles.length - 1]?.battleTime ?? null,
      latestBattleAt: battles[0]?.battleTime ?? null,
    },
  };
}

/** Load confirmed and incomplete club-membership history for one player. */
export async function loadPlayerClubs(
  input: { readonly tag: string; readonly now?: Date; readonly guildId?: string | null },
  options: PlayerReadOptions = {},
): Promise<ResolvedPlayerResult<PlayerClubsView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const guildId = input.guildId ?? options.guildId;
  const guildClubIds = await readGuildClubIds(guildId, db);
  const player = await readGuildScopedPlayer(normalized.tag, guildId, db, guildClubIds);
  if (player === null) return { kind: 'not-found', tag: normalized.tag };

  const [memberships, events] = await Promise.all([
    readMemberships(storedPlayerId(player), db, player.lastSyncedAt, staleAfterMs, now, guildClubIds),
    readEvents(storedPlayerId(player), db, guildClubIds),
  ]);
  const current = memberships.find((membership) => membership.status === 'current') ?? null;

  return {
    kind: 'ok',
    value: {
      player,
      currentClub: current,
      memberships,
      events,
      latestSyncAt: player.lastSyncedAt,
      lastBattleAt: player.lastBattleAt,
    },
  };
}

async function buildComparisonSide(
  player: PlayerIdentity,
  input: PlayerHistoryInput,
  db: DatabaseClient,
  snapshotOverride: string | null,
  staleAfterMs: number,
  now: Date,
  guildClubIds?: readonly string[] | null,
): Promise<{ side: Mutable<PlayerComparisonSide>; snapshots: ClubSnapshot[]; completedRunIds: Set<string> }> {
  const [{ snapshots, completedRunIds }, memberships] = await Promise.all([
    readCompletedSnapshots(storedPlayerId(player), db),
    readMemberships(storedPlayerId(player), db, player.lastSyncedAt, staleAfterMs, now, guildClubIds),
  ]);
  const periodSnapshots = filterPlayerSnapshots(snapshots, input.period, now);
  const points = toHistoryPoints(periodSnapshots);
  const selected = snapshotForRun(periodSnapshots, snapshotOverride);
  const currentAt = player.lastSyncedAt ?? selected?.capturedAt ?? null;

  return {
    snapshots,
    completedRunIds,
    side: {
      player,
      currentClub: memberships.find((membership) => membership.status === 'current') ?? null,
      currentTrophies: player.trophies,
      highestTrophies: player.highestTrophies,
      expLevel: player.expLevel,
      highestRecordedTrophies: highestRecordedTrophies(points, player.highestTrophies),
      progression: playerProgression(
        snapshots,
        selected?.trophies ?? player.trophies,
        currentAt,
        now,
        input.seasonStartIso,
      ),
      firstSnapshotAt: points[0]?.capturedAt ?? null,
      latestSnapshotAt: selected?.capturedAt ?? null,
      snapshotTrophies: selected?.trophies ?? null,
    },
  };
}

/** Compare two stored players without calling the official API. */
export async function loadPlayerCompare(
  input: {
    readonly firstTag: string;
    readonly secondTag: string;
    readonly period: HistoryPeriod;
    readonly now?: Date;
    readonly seasonStartIso?: string | undefined;
    readonly guildId?: string | null;
  },
  options: PlayerReadOptions = {},
): Promise<ResolvedPlayerResult<PlayerComparisonView>> {
  const firstTag = normalizePlayerTag(input.firstTag);
  const secondTag = normalizePlayerTag(input.secondTag);
  if (!firstTag.ok || !secondTag.ok || firstTag.tag === undefined || secondTag.tag === undefined) {
    return { kind: 'invalid-tag' };
  }
  if (firstTag.tag === secondTag.tag) return { kind: 'same-player' };

  const db = options.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const guildId = input.guildId ?? options.guildId ?? null;
  const guildClubIds = await readGuildClubIds(guildId, db);
  const [firstPlayer, secondPlayer] = await Promise.all([
    readGuildScopedPlayer(firstTag.tag, guildId, db, guildClubIds),
    readGuildScopedPlayer(secondTag.tag, guildId, db, guildClubIds),
  ]);
  if (firstPlayer === null) return { kind: 'not-found', tag: firstTag.tag };
  if (secondPlayer === null) return { kind: 'not-found', tag: secondTag.tag };
  if (firstPlayer.id === secondPlayer.id) return { kind: 'same-player' };
  const historyInput: PlayerHistoryInput = {
    tag: firstTag.tag,
    period: input.period,
    now,
    seasonStartIso: input.seasonStartIso,
    guildId,
  };
  const [first, second] = await Promise.all([
    buildComparisonSide(firstPlayer, historyInput, db, null, staleAfterMs, now, guildClubIds),
    buildComparisonSide(secondPlayer, { ...historyInput, tag: secondTag.tag }, db, null, staleAfterMs, now, guildClubIds),
  ]);
  const sharedRunId = sharedCompletedRunId(
    first.snapshots,
    second.snapshots,
    first.completedRunIds,
    second.completedRunIds,
  );

  if (sharedRunId !== null) {
    const alignedFirst = snapshotForRun(
      filterPlayerSnapshots(first.snapshots, input.period, now),
      sharedRunId,
    );
    const alignedSecond = snapshotForRun(
      filterPlayerSnapshots(second.snapshots, input.period, now),
      sharedRunId,
    );
    if (alignedFirst !== null && alignedSecond !== null) {
      const currentAt = firstPlayer.lastSyncedAt ?? alignedFirst.capturedAt;
      first.side.snapshotTrophies = alignedFirst.trophies;
      first.side.latestSnapshotAt = alignedFirst.capturedAt;
      first.side.progression = playerProgression(
        first.snapshots,
        alignedFirst.trophies,
        currentAt,
        now,
        input.seasonStartIso,
      );
      const secondAt = secondPlayer.lastSyncedAt ?? alignedSecond.capturedAt;
      second.side.snapshotTrophies = alignedSecond.trophies;
      second.side.latestSnapshotAt = alignedSecond.capturedAt;
      second.side.progression = playerProgression(
        second.snapshots,
        alignedSecond.trophies,
        secondAt,
        now,
        input.seasonStartIso,
      );
    }
  }

  const windowsDiffer = snapshotWindowsDiffer(
    first.side.firstSnapshotAt,
    first.side.latestSnapshotAt,
    second.side.firstSnapshotAt,
    second.side.latestSnapshotAt,
  );
  const aligned =
    sharedRunId !== null &&
    !windowsDiffer &&
    first.side.latestSnapshotAt !== null &&
    second.side.latestSnapshotAt !== null;
  const warnings: string[] = [];
  if (sharedRunId === null) {
    warnings.push('No shared completed snapshot exists; latest available snapshots were used.');
  }
  if (windowsDiffer) {
    warnings.push('Stored snapshots cover different periods; compare with care.');
  }

  return {
    kind: 'ok',
    value: {
      first: first.side,
      second: second.side,
      period: input.period,
      aligned,
      warning: warnings.length === 0 ? null : warnings.join(' '),
    },
  };
}
