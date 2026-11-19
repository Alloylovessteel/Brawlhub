import { createTrustedClient } from '@brawlhub/database';
import {
  asString,
  getRegisteredClubs,
  parseSnapshotRow,
  playerSnapshotAsClubSnapshot,
  readCompletedRuns,
  record,
  requireOk,
} from '../clubs/service';
import type { ClubRecord, ClubSnapshot, SyncRunRecord } from '../clubs/types';
import { highestRecordedTrophies, toHistoryPoints } from '../players/calculate';
import { parseMembershipRow, parsePlayerRow } from '../players/service';
import type { PlayerIdentity, PlayerMembershipRecord } from '../players/types';
import {
  averageTrophies,
  calculateProgression,
  chooseClub,
  commonRunId,
  deduplicatePlayers,
  isProgressionPeriod,
  rankByScore,
  timestampsDiffer,
  type ProgressionResult,
} from './calculate';
import type {
  ClubLeaderboardRow,
  ClubLeaderboardView,
  PlayerLeaderboardRow,
  PlayerLeaderboardView,
  ProgressionLeaderboardRow,
  ProgressionLeaderboardView,
  ProgressionPeriod,
  TrophyLeaderboardRow,
  TrophyLeaderboardView,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const STALE_AFTER_MS = 15 * 60_000;
const MAX_ROWS = 10_000;

const PLAYER_COLUMNS = [
  'id',
  'tag',
  'name',
  'trophies',
  'highest_trophies',
  'exp_level',
  'last_synced_at',
].join(', ');

const CLUB_SNAPSHOT_COLUMNS =
  'club_id, id, sync_run_id, captured_at, trophies, member_count, raw';
const PLAYER_SNAPSHOT_COLUMNS = 'id, player_id, sync_run_id, captured_at, trophies';
const MEMBERSHIP_SELECT =
  'id, club_id, player_id, role, valid_from, valid_to, ' +
  'club:clubs!club_memberships_club_id_fkey(id, tag, name)';

function finiteNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function playerKey(player: PlayerIdentity): string {
  return player.id ?? player.tag;
}

function latestRunAt(runs: readonly SyncRunRecord[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const timestamp = run.finishedAt ?? run.startedAt;
    if (timestamp === null) continue;
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latestMs = parsed;
      latest = timestamp;
    }
  }
  return latest;
}

function isValidSnapshot(snapshot: ClubSnapshot, completedRunIds: ReadonlySet<string>): boolean {
  return (
    completedRunIds.has(snapshot.syncRunId) &&
    finiteNumber(snapshot.trophies) !== null &&
    parseTimestamp(snapshot.capturedAt) !== null
  );
}

async function readPlayers(db: DatabaseClient): Promise<PlayerIdentity[]> {
  const { data, error } = await db
    .from('players')
    .select(PLAYER_COLUMNS)
    .order('name', { ascending: true })
    .limit(MAX_ROWS);
  requireOk(error, 'Read players');
  return deduplicatePlayers(
    (data ?? [])
      .map((row: unknown) => parsePlayerRow(row))
      .filter((row): row is PlayerIdentity => row !== null),
  );
}

async function readMemberships(
  db: DatabaseClient,
  players: readonly PlayerIdentity[],
  now: Date,
): Promise<Map<string, PlayerMembershipRecord[]>> {
  const byId = new Map(players.map((player) => [playerKey(player), player]));
  const grouped = new Map<string, PlayerMembershipRecord[]>();

  const { data, error } = await db
    .from('club_memberships')
    .select(MEMBERSHIP_SELECT)
    .order('valid_from', { ascending: false })
    .limit(MAX_ROWS);
  requireOk(error, 'Read memberships');

  for (const value of data ?? []) {
    const row = record(value);
    const playerId = asString(row?.['player_id']);
    if (row === null || playerId === null) continue;
    const player = byId.get(playerId);
    const membership = parseMembershipRow(
      row,
      STALE_AFTER_MS,
      now,
      player?.lastSyncedAt ?? null,
    );
    if (membership === null) continue;
    const existing = grouped.get(playerId) ?? [];
    existing.push(membership);
    grouped.set(playerId, existing);
  }

  return grouped;
}

/** Latest valid completed snapshot per club, keyed by club id. */
async function readClubSnapshots(
  db: DatabaseClient,
  completedRunIds: ReadonlySet<string>,
): Promise<Map<string, ClubSnapshot>> {
  const byClub = new Map<string, ClubSnapshot>();
  const { data, error } = await db
    .from('club_snapshots')
    .select(CLUB_SNAPSHOT_COLUMNS)
    .order('captured_at', { ascending: false })
    .limit(MAX_ROWS);
  requireOk(error, 'Read club snapshots');

  for (const value of data ?? []) {
    const row = record(value);
    const clubId = asString(row?.['club_id']);
    if (row === null || clubId === null) continue;
    const snapshot = parseSnapshotRow(row);
    if (snapshot === null || !isValidSnapshot(snapshot, completedRunIds)) continue;
    const existing = byClub.get(clubId);
    const existingAt = existing === undefined ? null : parseTimestamp(existing.capturedAt);
    const capturedAt = parseTimestamp(snapshot.capturedAt);
    if (
      existing === undefined ||
      (existingAt !== null && capturedAt !== null && capturedAt > existingAt)
    ) {
      byClub.set(clubId, snapshot);
    }
  }

  return byClub;
}

/** All valid completed snapshots grouped by player id. */
async function readPlayerSnapshotGroups(
  db: DatabaseClient,
  completedRunIds: ReadonlySet<string>,
): Promise<Map<string, ClubSnapshot[]>> {
  const grouped = new Map<string, ClubSnapshot[]>();
  const { data, error } = await db
    .from('player_snapshots')
    .select(PLAYER_SNAPSHOT_COLUMNS)
    .order('captured_at', { ascending: false })
    .limit(MAX_ROWS);
  requireOk(error, 'Read player snapshots');

  for (const value of data ?? []) {
    const row = record(value);
    const playerId = asString(row?.['player_id']);
    if (row === null || playerId === null) continue;
    const snapshot = playerSnapshotAsClubSnapshot(row);
    if (snapshot === null || !isValidSnapshot(snapshot, completedRunIds)) continue;
    const existing = grouped.get(playerId) ?? [];
    existing.push(snapshot);
    grouped.set(playerId, existing);
  }

  return grouped;
}

function nameCompare(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function clubCompare(a: ClubRecord, b: ClubRecord): number {
  return a.name.localeCompare(b.name) || a.tag.localeCompare(b.tag);
}

export interface LeaderboardReadOptions {
  readonly db?: DatabaseClient;
  readonly now?: Date;
  readonly guildId?: string | null;
}

/** Rank registered clubs by their latest valid completed-sync snapshot. */
export async function loadClubLeaderboard(
  options: LeaderboardReadOptions = {},
): Promise<ClubLeaderboardView> {
  const db = options.db ?? createTrustedClient();
  const now = options.now ?? new Date();
  const [clubs, runs] = await Promise.all([
    getRegisteredClubs(options.guildId, db),
    readCompletedRuns(db),
  ]);
  const completedRunIds = new Set(runs.map((run) => run.id));
  const byClub = await readClubSnapshots(db, completedRunIds);

  const ranked = rankByScore(
    clubs,
    (club) => finiteNumber(byClub.get(club.id)?.trophies ?? null),
    clubCompare,
  );
  const rows: ClubLeaderboardRow[] = ranked.map(({ rank, item: club }) => {
    const snapshot = byClub.get(club.id);
    if (snapshot === undefined) throw new Error('Ranked club is missing its snapshot');
    const totalTrophies = finiteNumber(snapshot.trophies) ?? 0;
    return {
      rank,
      club,
      totalTrophies,
      memberCount: finiteNumber(snapshot.memberCount),
      averageTrophies: averageTrophies(totalTrophies, snapshot.memberCount),
      snapshotAt: snapshot.capturedAt,
      syncRunId: snapshot.syncRunId,
    };
  });

  return {
    rows,
    generatedAt: now.toISOString(),
    latestSyncAt: latestRunAt(runs),
    warning: timestampsDiffer(rows.map((row) => row.snapshotAt))
      ? 'Club snapshots were captured at different times; totals are not time-aligned.'
      : null,
  };
}

/** Rank tracked players by their stored current trophies. */
export async function loadPlayerLeaderboard(
  options: LeaderboardReadOptions = {},
): Promise<PlayerLeaderboardView> {
  const db = options.db ?? createTrustedClient();
  const now = options.now ?? new Date();
  let players = await readPlayers(db);
  if (options.guildId !== undefined && options.guildId !== null) {
    const clubs = await getRegisteredClubs(options.guildId, db);
    const clubIds = clubs.map((club) => club.id);
    const allowedPlayerIds = new Set<string>();
    if (clubIds.length > 0) {
      const { data, error } = await db
        .from('club_memberships')
        .select('player_id')
        .in('club_id', clubIds)
        .limit(MAX_ROWS);
      requireOk(error, 'Read guild player memberships');
      for (const row of data ?? []) {
        const id = asString(record(row)?.['player_id']);
        if (id !== null) allowedPlayerIds.add(id);
      }
    }
    players = players.filter((player) => player.id !== null && allowedPlayerIds.has(player.id));
  }
  const [runs] = await Promise.all([readCompletedRuns(db)]);
  const memberships = await readMemberships(db, players, now);
  const validPlayers = players.filter((player) => finiteNumber(player.trophies) !== null);

  const ranked = rankByScore(
    validPlayers,
    (player) => finiteNumber(player.trophies),
    nameCompare,
  );
  const rows: PlayerLeaderboardRow[] = ranked.map(({ rank, item: player }) => {
    const choice = chooseClub(memberships.get(playerKey(player)) ?? []);
    return {
      rank,
      player,
      trophies: finiteNumber(player.trophies) ?? 0,
      club: choice?.club ?? null,
      clubStatus: choice?.status ?? null,
    };
  });

  const syncTimes = validPlayers
    .map((player) => player.lastSyncedAt)
    .filter((value): value is string => value !== null);
  const warning =
    syncTimes.length !== validPlayers.length
      ? 'Some player rows have no sync timestamp; values may not be time-aligned.'
      : timestampsDiffer(syncTimes)
        ? 'Player rows were last synced at different times; values are not time-aligned.'
        : null;

  return {
    rows,
    generatedAt: now.toISOString(),
    latestSyncAt: latestRunAt(runs),
    warning,
  };
}

/** Rank tracked players by recorded personal bests, keeping current trophies separate. */
export async function loadTrophyLeaderboard(
  options: LeaderboardReadOptions = {},
): Promise<TrophyLeaderboardView> {
  const db = options.db ?? createTrustedClient();
  const now = options.now ?? new Date();
  let players = await readPlayers(db);
  if (options.guildId !== undefined && options.guildId !== null) {
    const clubs = await getRegisteredClubs(options.guildId, db);
    const clubIds = clubs.map((club) => club.id);
    const allowedPlayerIds = new Set<string>();
    if (clubIds.length > 0) {
      const { data, error } = await db
        .from('club_memberships')
        .select('player_id')
        .in('club_id', clubIds)
        .limit(MAX_ROWS);
      requireOk(error, 'Read guild player memberships');
      for (const row of data ?? []) {
        const id = asString(record(row)?.['player_id']);
        if (id !== null) allowedPlayerIds.add(id);
      }
    }
    players = players.filter((player) => player.id !== null && allowedPlayerIds.has(player.id));
  }
  const [runs] = await Promise.all([readCompletedRuns(db)]);
  const completedRunIds = new Set(runs.map((run) => run.id));
  const snapshotGroups = await readPlayerSnapshotGroups(db, completedRunIds);
  const memberships = await readMemberships(db, players, now);

  const sources = players.map((player) => ({
    player,
    highest: highestRecordedTrophies(
      toHistoryPoints(snapshotGroups.get(playerKey(player)) ?? []),
      player.highestTrophies,
    ),
  }));
  const ranked = rankByScore(
    sources,
    (source) => finiteNumber(source.highest),
    (a, b) => nameCompare(a.player, b.player),
  );
  const rows: TrophyLeaderboardRow[] = ranked.map(({ rank, item }) => {
    const choice = chooseClub(memberships.get(playerKey(item.player)) ?? []);
    return {
      rank,
      player: item.player,
      highestTrophies: finiteNumber(item.highest) ?? 0,
      currentTrophies: finiteNumber(item.player.trophies),
      club: choice?.club ?? null,
      clubStatus: choice?.status ?? null,
    };
  });

  return {
    rows,
    generatedAt: now.toISOString(),
    latestSyncAt: latestRunAt(runs),
    warning: null,
  };
}

/** Rank real snapshot-to-snapshot trophy gains inside a bounded period. */
export async function loadProgressionLeaderboard(
  input: { readonly period: ProgressionPeriod; readonly now?: Date },
  options: LeaderboardReadOptions = {},
): Promise<ProgressionLeaderboardView> {
  if (!isProgressionPeriod(input.period)) {
    throw new Error('Unsupported progression period');
  }
  const db = options.db ?? createTrustedClient();
  const now = input.now ?? options.now ?? new Date();
  let players = await readPlayers(db);
  if (options.guildId !== undefined && options.guildId !== null) {
    const clubs = await getRegisteredClubs(options.guildId, db);
    const clubIds = clubs.map((club) => club.id);
    const allowedPlayerIds = new Set<string>();
    if (clubIds.length > 0) {
      const { data, error } = await db
        .from('club_memberships')
        .select('player_id')
        .in('club_id', clubIds)
        .limit(MAX_ROWS);
      requireOk(error, 'Read guild player memberships');
      for (const row of data ?? []) {
        const id = asString(record(row)?.['player_id']);
        if (id !== null) allowedPlayerIds.add(id);
      }
    }
    players = players.filter((player) => player.id !== null && allowedPlayerIds.has(player.id));
  }
  const [runs] = await Promise.all([readCompletedRuns(db)]);
  const completedRunIds = new Set(runs.map((run) => run.id));
  const snapshotGroups = await readPlayerSnapshotGroups(db, completedRunIds);

  const provisional = players
    .map((player) => ({
      player,
      result: calculateProgression(
        snapshotGroups.get(playerKey(player)) ?? [],
        input.period,
        now,
      ),
    }))
    .filter(
      (entry): entry is { player: PlayerIdentity; result: ProgressionResult } =>
        entry.result !== null,
    );

  // Align eligible players to the newest completed run shared by their latest
  // snapshots. Ineligible players must not force an older, irrelevant run.
  const sharedRunId = commonRunId(provisional.map((entry) => [entry.result.latest]));
  const calculated = provisional.map((entry) => {
    const aligned =
      sharedRunId === null
        ? null
        : calculateProgression(
            snapshotGroups.get(playerKey(entry.player)) ?? [],
            input.period,
            now,
            sharedRunId,
          );
    return { player: entry.player, result: aligned ?? entry.result };
  });
  const memberships = await readMemberships(db, players, now);

  const ranked = rankByScore(
    calculated,
    (entry) => entry.result.difference,
    (a, b) => nameCompare(a.player, b.player),
  );
  const rows: ProgressionLeaderboardRow[] = ranked.map(({ rank, item }) => {
    const choice = chooseClub(memberships.get(playerKey(item.player)) ?? []);
    return {
      rank,
      player: item.player,
      startTrophies: finiteNumber(item.result.start.trophies) ?? 0,
      latestTrophies: finiteNumber(item.result.latest.trophies) ?? 0,
      difference: item.result.difference,
      startAt: item.result.start.capturedAt,
      latestAt: item.result.latest.capturedAt,
      syncRunId: item.result.latest.syncRunId,
      club: choice?.club ?? null,
      clubStatus: choice?.status ?? null,
    };
  });

  const warnings: string[] = [];
  if (sharedRunId === null && calculated.length > 0) {
    warnings.push(
      'No single completed run covers the latest snapshot for every eligible player; gains may come from different runs.',
    );
  }
  if (sharedRunId !== null && calculated.some((entry) => !entry.result.alignedWithRun)) {
    warnings.push('Some latest snapshots could not be aligned to the shared completed run.');
  }
  if (timestampsDiffer(calculated.map((entry) => entry.result.start.capturedAt))) {
    warnings.push('Starting snapshots were captured at different times; gains are not time-aligned.');
  }

  return {
    period: input.period,
    rows,
    generatedAt: now.toISOString(),
    latestSyncAt: latestRunAt(runs),
    warning: warnings.length === 0 ? null : warnings.join(' '),
  };
}
