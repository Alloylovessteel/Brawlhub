import {
  BrawlStarsApiError,
  createBrawlStarsClient,
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
  readCompletedRuns,
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
  toHistoryPoints,
} from './calculate';
import type {
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
  'last_synced_at',
].join(', ');

const PLAYER_SNAPSHOT_COLUMNS =
  'id, player_id, sync_run_id, captured_at, trophies';

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

function escapeIlike(value: string): string {
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

function parsePlayerRow(value: unknown): PlayerIdentity | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const parsedTag = brawlTagSchema.safeParse(row['tag'] ?? '');
  const name = asString(row['name']);
  if (id === null || !parsedTag.success || name === null) return null;

  return {
    id,
    tag: parsedTag.data,
    name,
    trophies: asNumber(row['trophies']),
    highestTrophies: asNumber(row['highest_trophies']),
    expLevel: asNumber(row['exp_level']),
    lastSyncedAt: asString(row['last_synced_at']),
  };
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

function parseMembershipRow(value: unknown, staleAfterMs: number, now: Date, playerSyncedAt: string | null): PlayerMembershipRecord | null {
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

export async function searchPlayers(
  query: string,
  db: DatabaseClient = createTrustedClient(),
): Promise<PlayerIdentity[]> {
  const cleaned = query.trim().replace(/^#+/, '');
  const escaped = escapeIlike(cleaned);
  let builder = db.from('players').select(PLAYER_COLUMNS).order('name', { ascending: true }).limit(25);
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
  const runs = await readCompletedRuns(db);
  const completedRunIds = new Set(runs.map((run) => run.id));
  if (completedRunIds.size === 0) return { snapshots: [], completedRunIds };

  const { data, error } = await db
    .from('player_snapshots')
    .select(PLAYER_SNAPSHOT_COLUMNS)
    .eq('player_id', playerId)
    .order('captured_at', { ascending: true })
    .limit(2000);
  requireOk(error, 'Read player history');

  const snapshots = (data ?? [])
    .map((row: unknown) => playerSnapshotAsClubSnapshot(row))
    .filter((snapshot): snapshot is ClubSnapshot => snapshot !== null)
    .filter((snapshot) => completedRunIds.has(snapshot.syncRunId));
  return { snapshots, completedRunIds };
}

async function readMemberships(
  playerId: string,
  db: DatabaseClient,
  playerSyncedAt: string | null,
  staleAfterMs: number,
  now: Date,
): Promise<PlayerMembershipRecord[]> {
  const { data, error } = await db
    .from('club_memberships')
    .select(MEMBERSHIP_SELECT)
    .eq('player_id', playerId)
    .order('valid_from', { ascending: false })
    .limit(100);
  requireOk(error, 'Read club memberships');

  return (data ?? [])
    .map((row: unknown) => parseMembershipRow(row, staleAfterMs, now, playerSyncedAt))
    .filter((row): row is PlayerMembershipRecord => row !== null);
}

async function readEvents(
  playerId: string,
  db: DatabaseClient,
): Promise<PlayerMembershipEvent[]> {
  const { data, error } = await db
    .from('membership_events')
    .select(EVENT_SELECT)
    .eq('player_id', playerId)
    .order('detected_at', { ascending: false })
    .limit(100);
  requireOk(error, 'Read membership events');

  return (data ?? [])
    .map((row: unknown) => parseMembershipEventRow(row))
    .filter((row): row is PlayerMembershipEvent => row !== null);
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
  api: BrawlStarsClient,
  now: Date,
  useCache: boolean,
): Promise<LivePlayerFetchResult> {
  const cached = useCache ? playerApiCache.get(tag) : undefined;
  if (cached !== undefined && cached.expiresAt > now.getTime()) {
    return { profile: cached.profile, issue: null, notFound: false };
  }

  try {
    const profile = await api.getPlayer(tag);
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

function profileFromLive(live: Player, stored: PlayerIdentity | null, tag: string): PlayerIdentity {
  const base = stored ?? {
    id: null,
    tag,
    trophies: null,
    highestTrophies: null,
    expLevel: null,
    lastSyncedAt: null,
    name: live.name,
  };
  return {
    ...base,
    tag,
    name: live.name,
    trophies: live.trophies,
    highestTrophies: live.highscore ?? base.highestTrophies,
    expLevel: live.expLevel ?? base.expLevel,
  };
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
}

export interface PlayerHistoryInput {
  readonly tag: string;
  readonly period: HistoryPeriod;
  readonly now?: Date;
  readonly seasonStartIso?: string | undefined;
}

/** Load a detailed player profile, refreshing stale data from the official API. */
export async function loadPlayerProfile(
  input: { readonly tag: string; readonly now?: Date },
  options: PlayerServiceOptions = {},
): Promise<ResolvedPlayerResult<PlayerProfileView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const api = options.api ?? createBrawlStarsClient();
  const now = input.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const stored = await readPlayerByTag(normalized.tag, db);
  const needsRefresh =
    stored === null || !isRecentSync(stored.lastSyncedAt, now, staleAfterMs);
  const live = needsRefresh
    ? await fetchLivePlayer(normalized.tag, api, now, options.useCache ?? true)
    : emptyLiveResult();

  if (stored === null && live.profile === null) {
    return live.notFound
      ? { kind: 'not-found', tag: normalized.tag }
      : {
          kind: 'api-unavailable',
          tag: normalized.tag,
          issue: live.issue ?? 'error',
        };
  }

  const effective = live.profile !== null
    ? profileFromLive(live.profile, stored, normalized.tag)
    : stored;
  if (effective === null) return { kind: 'not-found', tag: normalized.tag };

  const [history, memberships] = stored === null
    ? [{ snapshots: [] as ClubSnapshot[] }, [] as PlayerMembershipRecord[]]
    : await Promise.all([
        readCompletedSnapshots(storedPlayerId(stored), db),
        readMemberships(storedPlayerId(stored), db, stored.lastSyncedAt, staleAfterMs, now),
      ]);

  const brawlers = (live.profile?.brawlers ?? [])
    .map((brawler) => ({ name: brawler.name, trophies: brawler.trophies }))
    .sort((a, b) => b.trophies - a.trophies)
    .slice(0, 5);
  const apiIssue: PlayerProfileView['apiIssue'] = live.notFound
    ? 'not-found'
    : live.issue;

  return {
    kind: 'ok',
    value: {
      player: effective,
      currentClub: liveClubRef(live.profile?.club) ?? selectCurrentClub(memberships),
      brawlers,
      latestSnapshotAt: latestSnapshot(history.snapshots)?.capturedAt ?? null,
      source: live.profile !== null ? 'live' : 'stored',
      apiIssue,
      profileFetchedAt: live.profile !== null ? now.toISOString() : null,
    },
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
  const player = await readPlayerByTag(normalized.tag, db);
  if (player === null) return { kind: 'not-found', tag: normalized.tag };

  const [{ snapshots }, memberships, events] = await Promise.all([
    readCompletedSnapshots(storedPlayerId(player), db),
    readMemberships(storedPlayerId(player), db, player.lastSyncedAt, staleAfterMs, now),
    readEvents(storedPlayerId(player), db),
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

/** Load confirmed and incomplete club-membership history for one player. */
export async function loadPlayerClubs(
  input: { readonly tag: string; readonly now?: Date },
  options: PlayerReadOptions = {},
): Promise<ResolvedPlayerResult<PlayerClubsView>> {
  const normalized = normalizePlayerTag(input.tag);
  if (!normalized.ok || normalized.tag === undefined) return { kind: 'invalid-tag' };

  const db = options.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const player = await readPlayerByTag(normalized.tag, db);
  if (player === null) return { kind: 'not-found', tag: normalized.tag };

  const [memberships, events] = await Promise.all([
    readMemberships(storedPlayerId(player), db, player.lastSyncedAt, staleAfterMs, now),
    readEvents(storedPlayerId(player), db),
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
): Promise<{ side: Mutable<PlayerComparisonSide>; snapshots: ClubSnapshot[]; completedRunIds: Set<string> }> {
  const [{ snapshots, completedRunIds }, memberships] = await Promise.all([
    readCompletedSnapshots(storedPlayerId(player), db),
    readMemberships(storedPlayerId(player), db, player.lastSyncedAt, staleAfterMs, now),
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
  const [firstPlayer, secondPlayer] = await Promise.all([
    readPlayerByTag(firstTag.tag, db),
    readPlayerByTag(secondTag.tag, db),
  ]);
  if (firstPlayer === null) return { kind: 'not-found', tag: firstTag.tag };
  if (secondPlayer === null) return { kind: 'not-found', tag: secondTag.tag };
  if (firstPlayer.id === secondPlayer.id) return { kind: 'same-player' };

  const historyInput: PlayerHistoryInput = {
    tag: firstTag.tag,
    period: input.period,
    now,
    seasonStartIso: input.seasonStartIso,
  };
  const [first, second] = await Promise.all([
    buildComparisonSide(firstPlayer, historyInput, db, null, staleAfterMs, now),
    buildComparisonSide(secondPlayer, historyInput, db, null, staleAfterMs, now),
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
