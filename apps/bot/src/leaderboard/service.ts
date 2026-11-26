import { createTrustedClient } from '@brawlhub/database';
import {
  asString,
  getRegisteredClubs,
  parseSnapshotRow,
  playerSnapshotAsClubSnapshot,
  readCompletedRuns,
  readCompletedRunsForIds,
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
/** Page size below PostgREST's max_rows (1000) for RPCs and ID lookups. */
const PAGE_SIZE = 500;

const PLAYER_COLUMNS = [
  'id',
  'tag',
  'name',
  'trophies',
  'highest_trophies',
  'exp_level',
  'last_synced_at',
].join(', ');

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

/** Read a table-valued RPC; PostgREST returns an array of rows. */
async function readRpcRows(
  db: DatabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  const { data, error } = await db.rpc(name, args);
  requireOk(error, `Read ${name}`);
  return Array.isArray(data) ? data : [];
}

/** A blank guild is a zero scope, never a global pass. */
async function readLeaderboardClubs(
  guildId: string | null | undefined,
  db: DatabaseClient,
): Promise<ClubRecord[]> {
  if (guildId !== undefined && guildId !== null && guildId.trim() === '') return [];
  return getRegisteredClubs(guildId ?? null, db);
}

/**
 * Player eligibility is resolved in SQL from an explicit club-id scope. The
 * RPC is a distinct-id keyset page, so neither a global player scan nor an
 * application-side membership set can be truncated by the REST row cap.
 */
async function readScopedPlayerIds(clubIds: readonly string[], db: DatabaseClient): Promise<string[]> {
  if (clubIds.length === 0) return [];
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const rows = await readRpcRows(db, 'web_scoped_player_ids', {
      p_club_ids: [...clubIds],
      p_current_only: false,
      p_limit: PAGE_SIZE,
      p_after: after,
    });
    const pageIds = rows
      .map((value) => asString(record(value)?.['player_id']))
      .filter((id): id is string => id !== null);
    for (const id of pageIds) ids.add(id);
    if (rows.length < PAGE_SIZE) break;
    const last = pageIds.at(-1) ?? null;
    if (last === null || last === after) {
      throw new Error('Read web_scoped_player_ids: repeated keyset');
    }
    after = last;
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function readPlayersByIds(
  db: DatabaseClient,
  playerIds: readonly string[],
): Promise<PlayerIdentity[]> {
  const players: PlayerIdentity[] = [];
  for (let index = 0; index < playerIds.length; index += PAGE_SIZE) {
    const { data, error } = await db
      .from('players')
      .select(PLAYER_COLUMNS)
      .in('id', playerIds.slice(index, index + PAGE_SIZE));
    requireOk(error, 'Read players');
    for (const row of data ?? []) {
      const player = parsePlayerRow(row);
      if (player !== null) players.push(player);
    }
  }
  return deduplicatePlayers(players);
}

async function readMemberships(
  db: DatabaseClient,
  players: readonly PlayerIdentity[],
  now: Date,
): Promise<Map<string, PlayerMembershipRecord[]>> {
  const byId = new Map(players.map((player) => [playerKey(player), player]));
  const grouped = new Map<string, PlayerMembershipRecord[]>();
  const playerIds = [...byId.keys()];

  for (let index = 0; index < playerIds.length; index += PAGE_SIZE) {
    const { data, error } = await db
      .from('club_memberships')
      .select(MEMBERSHIP_SELECT)
      .in('player_id', playerIds.slice(index, index + PAGE_SIZE));
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
  }

  return grouped;
}

interface PlayerLeaderboardScope {
  readonly clubs: ClubRecord[];
  readonly clubIds: string[];
  readonly players: PlayerIdentity[];
  readonly memberships: Map<string, PlayerMembershipRecord[]>;
}

/** One complete, guild-scoped eligibility read shared by all player views. */
async function readPlayerLeaderboardScope(
  options: LeaderboardReadOptions,
  db: DatabaseClient,
  now: Date,
): Promise<PlayerLeaderboardScope> {
  const clubs = await readLeaderboardClubs(options.guildId, db);
  const clubIds = [...new Set(clubs.map((club) => club.id))];
  const playerIds = await readScopedPlayerIds(clubIds, db);
  const players = await readPlayersByIds(db, playerIds);
  return { clubs, clubIds, players, memberships: await readMemberships(db, players, now) };
}

/**
 * Completed status is resolved for the runs actually referenced by the stored
 * snapshots, so no global recent-runs cap can make old history look invalid.
 */
async function completedRunIdsForSnapshots(
  snapshots: readonly ClubSnapshot[],
  db: DatabaseClient,
): Promise<Set<string>> {
  return new Set(
    (await readCompletedRunsForIds(snapshots.map((snapshot) => snapshot.syncRunId), db)).map(
      (run) => run.id,
    ),
  );
}

/** Read every newest-first page of a snapshot RPC using its stable keyset. */
async function readPagedSnapshots(
  db: DatabaseClient,
  name: string,
  baseArgs: Record<string, unknown>,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let afterCapturedAt: string | null = null;
  let afterId: string | null = null;

  for (;;) {
    const page = await readRpcRows(db, name, {
      ...baseArgs,
      p_limit: PAGE_SIZE,
      p_after_captured_at: afterCapturedAt,
      p_after_id: afterId,
    });
    if (page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;

    const last = record(page.at(-1));
    const capturedAt = asString(last?.['captured_at']);
    const id = asString(last?.['id']);
    if (capturedAt === null || id === null) {
      throw new Error(`Read ${name}: missing snapshot keyset`);
    }
    if (
      afterCapturedAt !== null &&
      afterId !== null &&
      !(capturedAt < afterCapturedAt || (capturedAt === afterCapturedAt && id < afterId))
    ) {
      throw new Error(`Read ${name}: non-monotonic snapshot keyset`);
    }
    afterCapturedAt = capturedAt;
    afterId = id;
  }

  return rows;
}

/** Latest valid completed snapshot per club, keyed by club id. */
async function readClubSnapshots(
  db: DatabaseClient,
  clubIds: readonly string[],
): Promise<Map<string, ClubSnapshot>> {
  const byClub = new Map<string, ClubSnapshot>();
  if (clubIds.length === 0) return byClub;

  const rows = await readPagedSnapshots(db, 'club_snapshot_page', {
    p_club_ids: [...clubIds],
    p_completed_only: true,
    p_newest_first: true,
  });
  const parsed: { clubId: string; snapshot: ClubSnapshot }[] = [];
  for (const value of rows) {
    const row = record(value);
    const clubId = asString(row?.['club_id']);
    if (row === null || clubId === null) continue;
    const snapshot = parseSnapshotRow(row);
    if (
      snapshot === null ||
      finiteNumber(snapshot.trophies) === null ||
      parseTimestamp(snapshot.capturedAt) === null
    ) {
      continue;
    }
    parsed.push({ clubId, snapshot });
  }
  const completedRunIds = await completedRunIdsForSnapshots(
    parsed.map((entry) => entry.snapshot),
    db,
  );

  for (const { clubId, snapshot } of parsed) {
    if (!completedRunIds.has(snapshot.syncRunId)) continue;
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
  clubIds: readonly string[],
): Promise<Map<string, ClubSnapshot[]>> {
  const grouped = new Map<string, ClubSnapshot[]>();
  if (clubIds.length === 0) return grouped;

  const rows = await readPagedSnapshots(db, 'player_snapshot_page', {
    p_club_ids: [...clubIds],
    p_completed_only: true,
    p_newest_first: true,
  });
  const parsed: { playerId: string; snapshot: ClubSnapshot }[] = [];
  for (const value of rows) {
    const row = record(value);
    const playerId = asString(row?.['player_id']);
    if (row === null || playerId === null) continue;
    const snapshot = playerSnapshotAsClubSnapshot(row);
    if (
      snapshot === null ||
      finiteNumber(snapshot.trophies) === null ||
      parseTimestamp(snapshot.capturedAt) === null
    ) {
      continue;
    }
    parsed.push({ playerId, snapshot });
  }
  const completedRunIds = await completedRunIdsForSnapshots(
    parsed.map((entry) => entry.snapshot),
    db,
  );

  for (const { playerId, snapshot } of parsed) {
    if (!completedRunIds.has(snapshot.syncRunId)) continue;
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
    readLeaderboardClubs(options.guildId, db),
    readCompletedRuns(db),
  ]);
  const clubIds = [...new Set(clubs.map((club) => club.id))];
  const byClub = await readClubSnapshots(db, clubIds);

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
  const scope = await readPlayerLeaderboardScope(options, db, now);
  const players = scope.players;
  const [runs] = await Promise.all([readCompletedRuns(db)]);
  const memberships = scope.memberships;
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
  const scope = await readPlayerLeaderboardScope(options, db, now);
  const players = scope.players;
  const [runs] = await Promise.all([readCompletedRuns(db)]);
  const snapshotGroups = await readPlayerSnapshotGroups(db, scope.clubIds);
  const memberships = scope.memberships;

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
  const scope = await readPlayerLeaderboardScope(options, db, now);
  const players = scope.players;
  const [runs] = await Promise.all([readCompletedRuns(db)]);
  const snapshotGroups = await readPlayerSnapshotGroups(db, scope.clubIds);

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
  const memberships = scope.memberships;

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
