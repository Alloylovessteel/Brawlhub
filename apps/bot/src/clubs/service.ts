import {
  BrawlStarsApiError,
  createBrawlStarsClient,
  type BrawlStarsClient,
} from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { brawlTagSchema } from '@brawlhub/shared';
import {
  calculateAverage,
  calculateAverageMatches,
  calculateHistoryChange,
  calculateMegaPigEstimate,
  calculateTrophyProgression,
  calculateTrophyRange,
  filterSnapshotsByPeriod,
  HISTORY_PERIOD_DAYS,
  rankByTrophies,
  sortMembersByTrophies,
} from './calculate';
import type {
  ApiIssue,
  ClubLookupFailure,
  ClubRecord,
  ClubSnapshot,
  ClubSummary,
  ClubView,
  ComparisonSide,
  ComparisonView,
  HistoryPeriod,
  HistoryPoint,
  HistoryView,
  LeaderboardEntry,
  LeaderboardView,
  LoadClubResult,
  MatchActivity,
  MegaPigEstimate,
  MemberDetail,
  MemberView,
  MembershipChange,
  PlayerRecord,
  ResolvedClubResult,
  RosterMember,
  RosterSource,
  SyncedClubView,
  SyncRunRecord,
  TrophyProgression,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

interface LiveClubData {
  readonly trophies: number;
  readonly roster: RosterMember[];
  readonly description: string | null;
  readonly requiredTrophies: number | null;
  readonly type: string | null;
  readonly badgeId: number | null;
}

interface LiveClubFetchResult {
  readonly data: LiveClubData | null;
  readonly issue: ApiIssue | null;
}

const LIVE_CLUB_CACHE_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const liveClubCache = new Map<string, { expiresAt: number; result: LiveClubFetchResult }>();

/** Clear the in-process live club cache. Useful after API credential changes. */
export function clearClubLiveCache(): void {
  liveClubCache.clear();
}

const CLUB_COLUMNS = [
  'id',
  'tag',
  'name',
  'description',
  'trophies',
  'required_trophies',
  'member_count',
  'last_synced_at',
].join(', ');

const SYNC_RUN_COLUMNS = [
  'id',
  'status',
  'started_at',
  'finished_at',
  'affected_club_ids',
  'club_tags',
].join(', ');

const SNAPSHOT_COLUMNS = [
  'id',
  'sync_run_id',
  'captured_at',
  'trophies',
  'member_count',
  'raw',
].join(', ');

const MEMBERSHIP_COLUMNS =
  'player_id, role, valid_to, player:players!club_memberships_player_id_fkey(tag, name, trophies)';

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function relationRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return record(candidate);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

const ACTIVITY_DAY_MS = 24 * 60 * 60 * 1000;

function utcMidnightMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function utcWeekStartMs(date: Date): number {
  const midnight = utcMidnightMs(date);
  const mondayOffset = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - mondayOffset * ACTIVITY_DAY_MS;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function readMegaPigWindow(): { start: string; end: string } | null {
  const start = process.env.BRAWL_MEGA_PIG_START_ISO?.trim();
  const end = process.env.BRAWL_MEGA_PIG_END_ISO?.trim();
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

async function readPlayerIdsByTags(
  tags: readonly string[],
  db: DatabaseClient,
): Promise<Map<string, { id: string; lastBattleAt: string | null }>> {
  const unique = [...new Set(tags.filter((tag) => tag.length > 0))];
  if (unique.length === 0) return new Map();
  const { data, error } = await db
    .from('players')
    .select('id, tag, last_battle_at')
    .in('tag', unique);
  requireOk(error, 'Read player ids for activity');
  const map = new Map<string, { id: string; lastBattleAt: string | null }>();
  for (const row of data ?? []) {
    const source = record(row);
    const id = asString(source?.['id']);
    const tag = asString(source?.['tag']);
    if (id === null || tag === null) continue;
    map.set(tag, { id, lastBattleAt: asString(source?.['last_battle_at']) });
  }
  return map;
}

async function readBattleActivityForRoster(
  roster: readonly RosterMember[],
  now: Date,
  seasonStartIso: string | undefined,
  db: DatabaseClient,
): Promise<{ matchActivity: MatchActivity | null; megaPigEstimate: MegaPigEstimate | null }> {
  const tags = roster.map((member) => member.tag);
  const playerMap = await readPlayerIdsByTags(tags, db);
  const memberPlayerIds = tags
    .map((tag) => playerMap.get(tag)?.id)
    .filter((id): id is string => typeof id === 'string');
  const lastBattleAt = [...playerMap.values()]
    .map((entry) => entry.lastBattleAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1) ?? null;

  if (memberPlayerIds.length === 0) {
    const megaWindow = readMegaPigWindow();
    return {
      matchActivity: null,
      megaPigEstimate: megaWindow
        ? calculateMegaPigEstimate({ rows: [], windowStart: megaWindow.start, windowEnd: megaWindow.end })
        : null,
    };
  }

  const todayMs = utcMidnightMs(now);
  const weekMs = utcWeekStartMs(now);
  const seasonMs = parseIsoMs(seasonStartIso);
  const boundaries = [todayMs, weekMs, ...(seasonMs === null ? [] : [seasonMs])];
  const earliest = Math.min(...boundaries);
  const earliestIso = new Date(earliest).toISOString();

  const { data, error } = await db
    .from('player_battles')
    .select('player_id, battle_time')
    .in('player_id', memberPlayerIds)
    .gte('battle_time', earliestIso)
    .limit(10000);
  requireOk(error, 'Read player battle activity');

  const countsByPlayer = new Map<string, { today: number; week: number; season: number }>();
  for (const id of memberPlayerIds) countsByPlayer.set(id, { today: 0, week: 0, season: 0 });
  for (const row of data ?? []) {
    const source = record(row);
    const playerId = asString(source?.['player_id']);
    const battleTime = asString(source?.['battle_time']);
    if (playerId === null || battleTime === null) continue;
    const ms = Date.parse(battleTime);
    if (Number.isNaN(ms)) continue;
    const counts = countsByPlayer.get(playerId);
    if (counts === undefined) continue;
    if (ms >= todayMs) counts.today += 1;
    if (ms >= weekMs) counts.week += 1;
    if (seasonMs !== null && ms >= seasonMs) counts.season += 1;
  }

  const matchActivity = calculateAverageMatches({
    countsByPlayer,
    memberPlayerIds,
    lastBattleAt,
  });

  const megaWindow = readMegaPigWindow();
  let megaPigEstimate: MegaPigEstimate | null = null;
  if (megaWindow !== null) {
    const { data: megaData, error: megaError } = await db
      .from('player_battles')
      .select('player_id, result, trophy_change')
      .in('player_id', memberPlayerIds)
      .gte('battle_time', megaWindow.start)
      .lte('battle_time', megaWindow.end)
      .limit(10000);
    if (megaError) {
      megaPigEstimate = calculateMegaPigEstimate({
        rows: [],
        windowStart: megaWindow.start,
        windowEnd: megaWindow.end,
      });
    } else {
      const byPlayer = new Map<string, { matches: number; wins: number; trophyChange: number }>();
      for (const row of megaData ?? []) {
        const source = record(row);
        const playerId = asString(source?.['player_id']);
        if (playerId === null) continue;
        const current = byPlayer.get(playerId) ?? { matches: 0, wins: 0, trophyChange: 0 };
        current.matches += 1;
        if (asString(source?.['result']) === 'victory') current.wins += 1;
        const trophyChange = asNumber(source?.['trophy_change']);
        if (trophyChange !== null) current.trophyChange += trophyChange;
        byPlayer.set(playerId, current);
      }
      megaPigEstimate = calculateMegaPigEstimate({
        rows: [...byPlayer.values()],
        windowStart: megaWindow.start,
        windowEnd: megaWindow.end,
      });
    }
  }

  return { matchActivity, megaPigEstimate };
}

type NormalizedLookupTag =
  | { readonly ok: true; readonly tag: string | undefined }
  | { readonly ok: false };

/** Shared tag validation for every club command. Blank means "use the default". */
function normalizeLookupTag(tag: string | undefined): NormalizedLookupTag {
  if (tag === undefined || tag.trim() === '') {
    return { ok: true, tag: undefined };
  }
  const parsed = brawlTagSchema.safeParse(tag);
  return parsed.success ? { ok: true, tag: parsed.data } : { ok: false };
}

function clubLookupFailure(
  club: ClubRecord | null,
  normalizedTag: string | undefined,
): ClubLookupFailure | null {
  if (club !== null) return null;
  return normalizedTag === undefined
    ? { kind: 'no-default' }
    : { kind: 'unregistered', tag: normalizedTag };
}

export function requireOk(error: { message?: string } | null | undefined, context: string): void {
  if (error !== null && error !== undefined) {
    throw new Error(`${context} failed`);
  }
}

function parseClubRow(value: unknown): ClubRecord | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const tag = asString(row['tag']);
  const name = asString(row['name']);
  if (id === null || tag === null || name === null) return null;

  return {
    id,
    tag,
    name,
    description: asString(row['description']),
    trophies: asNumber(row['trophies']),
    requiredTrophies: asNumber(row['required_trophies']),
    memberCount: asNumber(row['member_count']),
    lastSyncedAt: asString(row['last_synced_at']),
  };
}

export function parseSyncRunRow(value: unknown): SyncRunRecord | null {
  const row = record(value);
  if (row === null || row['status'] !== 'completed') return null;
  const id = asString(row['id']);
  if (id === null) return null;

  return {
    id,
    status: 'completed',
    startedAt: asString(row['started_at']),
    finishedAt: asString(row['finished_at']),
    affectedClubIds: asStringArray(row['affected_club_ids']),
    clubTags: asStringArray(row['club_tags']),
  };
}

export function parseSnapshotRow(value: unknown): ClubSnapshot | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const syncRunId = asString(row['sync_run_id']);
  const capturedAt = asString(row['captured_at']);
  if (id === null || syncRunId === null || capturedAt === null) return null;

  return {
    id,
    syncRunId,
    capturedAt,
    trophies: asNumber(row['trophies']),
    memberCount: asNumber(row['member_count']),
    raw: row['raw'] ?? null,
  };
}

function parseApiMembers(value: unknown): RosterMember[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const members: RosterMember[] = [];

  for (const item of value) {
    const row = record(item);
    if (row === null) continue;
    const parsedTag = brawlTagSchema.safeParse(row['tag'] ?? '');
    const name = asString(row['name']);
    if (!parsedTag.success || name === null || seen.has(parsedTag.data)) continue;
    seen.add(parsedTag.data);
    members.push({
      tag: parsedTag.data,
      name,
      trophies: asNumber(row['trophies']),
      role: asString(row['role']),
    });
  }

  return members;
}

function parseMembershipRoster(value: unknown): RosterMember[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const members: RosterMember[] = [];

  for (const item of value) {
    const row = record(item);
    if (row === null) continue;
    const player = relationRecord(row['player']);
    const tag = brawlTagSchema.safeParse(player?.['tag'] ?? '');
    const name = asString(player?.['name']);
    if (!tag.success || name === null || seen.has(tag.data)) continue;
    seen.add(tag.data);
    members.push({
      tag: tag.data,
      name,
      trophies: asNumber(player?.['trophies']),
      role: asString(row['role']),
    });
  }

  return members;
}

function readRawDescription(raw: unknown): string | null {
  const value = record(raw)?.['description'];
  return asString(value);
}

function readRawType(raw: unknown): string | null {
  return asString(record(raw)?.['type']);
}

function readRawBadgeId(raw: unknown): number | null {
  return asNumber(record(raw)?.['badgeId']);
}

function latestCompletedSnapshot(
  snapshots: readonly ClubSnapshot[],
  completedRunIds: ReadonlySet<string>,
): ClubSnapshot | null {
  let latest: ClubSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (!completedRunIds.has(snapshot.syncRunId)) continue;
    if (Number.isNaN(Date.parse(snapshot.capturedAt))) continue;
    if (latest === null || Date.parse(snapshot.capturedAt) > Date.parse(latest.capturedAt)) {
      latest = snapshot;
    }
  }
  return latest;
}

function snapshotRoster(
  snapshots: readonly ClubSnapshot[],
  completedRunIds: ReadonlySet<string>,
): { roster: RosterMember[]; capturedAt: string } | null {
  const eligible = snapshots
    .filter((snapshot) => completedRunIds.has(snapshot.syncRunId))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const roster = parseApiMembers(record(eligible[index]?.raw)?.['members']);
    if (roster.length > 0) {
      return { roster, capturedAt: eligible[index]?.capturedAt ?? '' };
    }
  }
  return null;
}

function latestSuccessfulSyncAt(
  club: ClubRecord,
  runs: readonly SyncRunRecord[],
): string | null {
  for (const run of runs) {
    const matchesClub =
      run.affectedClubIds.includes(club.id) ||
      run.clubTags.some((tag) => brawlTagSchema.safeParse(tag).data === club.tag);
    if (!matchesClub) continue;
    const timestamp = run.finishedAt ?? run.startedAt;
    if (timestamp !== null) return timestamp;
  }
  return null;
}

export function classifyApiError(error: unknown): ApiIssue {
  if (error instanceof BrawlStarsApiError) {
    if (error.status === 429) return 'rate-limit';
    if (error.status === 401 || error.status === 403) return 'unauthorized';
  }
  return 'error';
}

/** Fetch live club data once per tag for a short TTL, including failures. */
async function fetchLiveClub(
  tag: string,
  api: BrawlStarsClient,
  now: Date,
  useCache: boolean,
): Promise<LiveClubFetchResult> {
  const cached = useCache ? liveClubCache.get(tag) : undefined;
  if (cached !== undefined && cached.expiresAt > now.getTime()) {
    return cached.result;
  }

  let result: LiveClubFetchResult;
  try {
    const liveClub = await api.getClub(tag);
    const returnedTag = brawlTagSchema.safeParse(liveClub.tag);
    if (!returnedTag.success || returnedTag.data !== tag) {
      throw new BrawlStarsApiError('Official API returned a mismatched club tag', 0);
    }

    let roster = parseApiMembers(liveClub.members);
    if (roster.length === 0) {
      roster = parseApiMembers(await api.getClubMembers(tag));
    }

    result = {
      data: {
        trophies: liveClub.trophies,
        roster,
        description: liveClub.description ?? null,
        requiredTrophies: liveClub.requiredTrophies ?? null,
        type: asString((liveClub as unknown as Record<string, unknown>)['type']) ?? liveClub.type ?? null,
        badgeId: typeof liveClub.badgeId === 'number' && Number.isFinite(liveClub.badgeId)
          ? liveClub.badgeId
          : null,
      },
      issue: null,
    };
  } catch (error) {
    result = { data: null, issue: classifyApiError(error) };
  }

  if (useCache) {
    liveClubCache.set(tag, { expiresAt: now.getTime() + LIVE_CLUB_CACHE_MS, result });
  }
  return result;
}

async function readClubs(
  db: DatabaseClient,
  guildId?: string | null,
): Promise<ClubRecord[]> {
  let query = db.from('clubs').select(CLUB_COLUMNS).order('name', { ascending: true });
  if (guildId !== undefined && guildId !== null && guildId.trim() !== '') {
    query = query.eq('guild_id', guildId.trim());
  }
  const { data, error } = await query;
  requireOk(error, 'Read registered clubs');
  return (data ?? [])
    .map((row: unknown) => parseClubRow(row))
    .filter((row): row is ClubRecord => row !== null);
}

async function findClubByTag(
  tag: string,
  db: DatabaseClient,
  guildId?: string | null,
): Promise<ClubRecord | null> {
  let query = db.from('clubs').select(CLUB_COLUMNS).eq('tag', tag);
  if (guildId !== undefined && guildId !== null && guildId.trim() !== '') {
    query = query.eq('guild_id', guildId.trim());
  }
  const { data, error } = guildId ? await query.maybeSingle() : await query.limit(2);
  if (error !== null && error !== undefined) {
    requireOk(error, 'Read registered club');
  }
  if (!guildId) {
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length > 1) {
      throw new Error(`Club tag ${tag} is registered in multiple servers; guild context is required`);
    }
    return parseClubRow(rows[0] ?? null);
  }
  return parseClubRow(data);
}

async function findClubById(
  id: string,
  db: DatabaseClient,
  guildId?: string | null,
): Promise<ClubRecord | null> {
  let query = db.from('clubs').select(CLUB_COLUMNS).eq('id', id);
  if (guildId !== undefined && guildId !== null && guildId.trim() !== '') {
    query = query.eq('guild_id', guildId.trim());
  }
  const { data, error } = await query.maybeSingle();
  requireOk(error, 'Read default club');
  return parseClubRow(data);
}

export async function readCompletedRuns(db: DatabaseClient): Promise<SyncRunRecord[]> {
  const { data, error } = await db
    .from('sync_runs')
    .select(SYNC_RUN_COLUMNS)
    .eq('status', 'completed')
    .order('finished_at', { ascending: false, nullsFirst: false })
    .order('started_at', { ascending: false })
    .limit(100);
  requireOk(error, 'Read sync history');
  return (data ?? [])
    .map((row: unknown) => parseSyncRunRow(row))
    .filter((row): row is SyncRunRecord => row !== null);
}

async function readSnapshots(clubId: string, db: DatabaseClient): Promise<ClubSnapshot[]> {
  const { data, error } = await db
    .from('club_snapshots')
    .select(SNAPSHOT_COLUMNS)
    .eq('club_id', clubId)
    .order('captured_at', { ascending: true })
    .limit(500);
  requireOk(error, 'Read club history');
  return (data ?? [])
    .map((row: unknown) => parseSnapshotRow(row))
    .filter((row): row is ClubSnapshot => row !== null);
}

async function readMembershipRoster(
  clubId: string,
  db: DatabaseClient,
): Promise<RosterMember[]> {
  const { data, error } = await db
    .from('club_memberships')
    .select(MEMBERSHIP_COLUMNS)
    .eq('club_id', clubId)
    .is('valid_to', null);
  requireOk(error, 'Read synced roster');
  return parseMembershipRoster(data);
}

async function resolveClub(input: {
  readonly tag?: string | undefined;
  readonly guildId?: string | null | undefined;
  readonly db: DatabaseClient;
}): Promise<ClubRecord | null> {
  if (input.tag !== undefined) {
    return findClubByTag(input.tag, input.db, input.guildId);
  }

  if (input.guildId !== undefined && input.guildId !== null) {
    const { data, error } = await input.db
      .from('guild_settings')
      .select('guild_id, primary_club_id')
      .eq('guild_id', input.guildId)
      .maybeSingle();
    requireOk(error, 'Read guild settings');
    const primaryClubId = asString(record(data)?.['primary_club_id']);
    if (primaryClubId !== null) {
      const configured = await findClubById(primaryClubId, input.db, input.guildId);
      if (configured !== null) return configured;
    }
  }

  // With no guild default, an unambiguous single registered club in this scope
  // is the default.
  const clubs = await readClubs(input.db, input.guildId);
  return clubs.length === 1 ? clubs[0] ?? null : null;
}

/** List registered clubs without contacting the Brawl Stars API. */
export async function getRegisteredClubs(
  guildIdOrDb?: string | null | DatabaseClient,
  dbArg?: DatabaseClient,
): Promise<ClubRecord[]> {
  const isDb =
    typeof guildIdOrDb === 'object' &&
    guildIdOrDb !== null &&
    typeof (guildIdOrDb as { from?: unknown }).from === 'function';
  const db = isDb ? (guildIdOrDb as DatabaseClient) : (dbArg ?? createTrustedClient());
  const guildId = isDb ? null : (guildIdOrDb as string | null | undefined);
  return readClubs(db, guildId);
}

export interface ClubServiceOptions {
  readonly db?: DatabaseClient;
  readonly api?: BrawlStarsClient;
  /** Disable the short-lived in-process API cache in tests or one-off scripts. */
  readonly useCache?: boolean;
}

/** Load a registered club's current and historical data without writing anything. */
export async function loadClubView(
  input: {
    readonly tag?: string | undefined;
    readonly guildId?: string | null | undefined;
    readonly now?: Date;
    readonly seasonStartIso?: string | undefined;
  },
  options: ClubServiceOptions = {},
): Promise<LoadClubResult> {
  const db = options.db ?? createTrustedClient();
  const api = options.api ?? createBrawlStarsClient();
  const now = input.now ?? new Date();

  const normalized = normalizeLookupTag(input.tag);
  if (!normalized.ok) return { kind: 'invalid-tag' };
  const normalizedTag = normalized.tag;

  const club = await resolveClub({ tag: normalizedTag, guildId: input.guildId, db });
  if (club === null) {
    return normalizedTag === undefined
      ? { kind: 'no-default' }
      : { kind: 'unregistered', tag: normalizedTag };
  }

  const [snapshots, runs] = await Promise.all([readSnapshots(club.id, db), readCompletedRuns(db)]);
  const completedRunIds = new Set(runs.map((run) => run.id));
  const latestSnapshot = latestCompletedSnapshot(snapshots, completedRunIds);
  const snapshotRosterResult = snapshotRoster(snapshots, completedRunIds);

  let roster = snapshotRosterResult?.roster ?? (await readMembershipRoster(club.id, db));
  let rosterAvailable = roster.length > 0;
  let rosterSource: RosterSource = snapshotRosterResult !== null ? 'snapshot' : 'memberships';
  let currentTrophies = latestSnapshot?.trophies ?? club.trophies;
  let currentAt = latestSnapshot?.capturedAt ?? '';
  let description = latestSnapshot === null
    ? club.description
    : (readRawDescription(latestSnapshot.raw) ?? club.description);
  let requiredTrophies = club.requiredTrophies;
  let type = latestSnapshot === null ? null : readRawType(latestSnapshot.raw);
  let badgeId = latestSnapshot === null ? null : readRawBadgeId(latestSnapshot.raw);
  let liveStatus: ClubView['liveStatus'] = 'sync-only';

  const live = await fetchLiveClub(club.tag, api, now, options.useCache ?? true);
  if (live.data !== null) {
    if (live.data.roster.length > 0) {
      roster = live.data.roster;
      rosterAvailable = true;
      rosterSource = 'live';
    }
    currentTrophies = live.data.trophies;
    currentAt = now.toISOString();
    description = live.data.description ?? description;
    requiredTrophies = live.data.requiredTrophies ?? requiredTrophies;
    type = live.data.type ?? type;
    badgeId = live.data.badgeId ?? badgeId;
    liveStatus = 'live';
  }

  const { matchActivity, megaPigEstimate } = await readBattleActivityForRoster(
    roster,
    now,
    input.seasonStartIso,
    db,
  );

  return {
    kind: 'ok',
    view: {
      club,
      roster,
      rosterAvailable,
      rosterSource,
      snapshots,
      currentTrophies,
      currentAt,
      description,
      requiredTrophies,
      type,
      badgeId,
      matchActivity,
      megaPigEstimate,
      latestSyncAt: latestSuccessfulSyncAt(club, runs),
      liveStatus,
      apiIssue: live.issue,
    },
  };
}

/** Build paginated list rows from registered clubs and existing sync data. */
export async function loadClubSummaries(
  db: DatabaseClient = createTrustedClient(),
): Promise<ClubSummary[]> {
  const [clubs, runs] = await Promise.all([readClubs(db), readCompletedRuns(db)]);
  const completedRunIds = new Set(runs.map((run) => run.id));

  return Promise.all(
    clubs.map(async (club) => {
      const snapshots = await readSnapshots(club.id, db);
      const latestSnapshot = latestCompletedSnapshot(snapshots, completedRunIds);
      const rosterResult = snapshotRoster(snapshots, completedRunIds);
      const roster = rosterResult?.roster ?? (await readMembershipRoster(club.id, db));
      const rosterAvailable = roster.length > 0;

      return {
        club,
        totalTrophies: latestSnapshot?.trophies ?? club.trophies,
        averageTrophies: rosterAvailable
          ? calculateAverage(roster.map((member) => member.trophies))
          : null,
        memberCount: rosterAvailable ? roster.length : club.memberCount,
        latestSyncAt: latestSuccessfulSyncAt(club, runs),
      };
    }),
  );
}

/** Rank registered clubs for slash-command autocomplete. */
export function filterRegisteredClubs(
  clubs: readonly ClubRecord[],
  query: string,
  limit = 25,
): ClubRecord[] {
  const needle = query.trim().toLowerCase();
  const normalizedNeedle = needle.replace(/^#+/, '');
  return clubs
    .filter((club) => {
      if (needle === '') return true;
      return (
        club.name.toLowerCase().includes(needle) ||
        club.tag.toLowerCase().includes(normalizedNeedle)
      );
    })
    .sort((a, b) => {
      if (needle === '') return a.name.localeCompare(b.name);
      const aStarts = a.name.toLowerCase().startsWith(needle) || a.tag.toLowerCase().startsWith(normalizedNeedle);
      const bStarts = b.name.toLowerCase().startsWith(needle) || b.tag.toLowerCase().startsWith(normalizedNeedle);
      return Number(bStarts) - Number(aStarts) || a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, Math.floor(limit)));
}

function parsePlayerRow(value: unknown): PlayerRecord | null {
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
  };
}

async function readPlayersByTags(
  tags: readonly string[],
  db: DatabaseClient,
): Promise<PlayerRecord[]> {
  const uniqueTags = [...new Set(tags)];
  if (uniqueTags.length === 0) return [];

  const { data, error } = await db
    .from('players')
    .select('id, tag, name, trophies, highest_trophies')
    .in('tag', uniqueTags);
  requireOk(error, 'Read player details');
  return (data ?? [])
    .map((row: unknown) => parsePlayerRow(row))
    .filter((row): row is PlayerRecord => row !== null);
}

interface PlayerSnapshotRow {
  readonly playerId: string;
  readonly snapshot: ClubSnapshot;
}

export function playerSnapshotAsClubSnapshot(value: unknown): ClubSnapshot | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const syncRunId = asString(row['sync_run_id']);
  const capturedAt = asString(row['captured_at']);
  if (id === null || syncRunId === null || capturedAt === null) return null;

  return {
    id,
    syncRunId,
    capturedAt,
    trophies: asNumber(row['trophies']),
    memberCount: null,
    raw: null,
  };
}

async function readPlayerSnapshots(
  playerIds: readonly string[],
  completedRunIds: ReadonlySet<string>,
  db: DatabaseClient,
): Promise<PlayerSnapshotRow[]> {
  if (playerIds.length === 0) return [];

  const { data, error } = await db
    .from('player_snapshots')
    .select('id, player_id, sync_run_id, captured_at, trophies')
    .in('player_id', [...new Set(playerIds)])
    .order('captured_at', { ascending: true })
    .limit(2000);
  requireOk(error, 'Read player history');

  return (data ?? [])
    .map((row: unknown) => {
      const source = record(row);
      const playerId = asString(source?.['player_id']);
      const snapshot = playerSnapshotAsClubSnapshot(row);
      if (
        playerId === null ||
        snapshot === null ||
        !completedRunIds.has(snapshot.syncRunId)
      ) {
        return null;
      }
      return { playerId, snapshot };
    })
    .filter((row): row is PlayerSnapshotRow => row !== null);
}

async function readMembershipEvents(
  clubId: string,
  period: HistoryPeriod,
  now: Date,
  db: DatabaseClient,
): Promise<MembershipChange[]> {
  const { data, error } = await db
    .from('membership_events')
    .select('id, event_type, detected_at, player:players!membership_events_player_id_fkey(tag, name)')
    .or(`from_club_id.eq.${clubId},to_club_id.eq.${clubId}`)
    .order('detected_at', { ascending: false })
    .limit(100);
  requireOk(error, 'Read membership history');

  const days = HISTORY_PERIOD_DAYS[period];
  const sinceMs = days === null ? null : now.getTime() - days * DAY_MS;
  const changes: MembershipChange[] = [];

  for (const item of data ?? []) {
    const row = record(item);
    if (row === null) continue;
    const eventType = asString(row['event_type']);
    const detectedAt = asString(row['detected_at']);
    if (
      (eventType !== 'join' && eventType !== 'leave' && eventType !== 'transfer') ||
      detectedAt === null
    ) {
      continue;
    }
    const capturedMs = Date.parse(detectedAt);
    if (Number.isNaN(capturedMs) || (sinceMs !== null && capturedMs < sinceMs)) continue;

    const player = relationRecord(row['player']);
    const parsedTag = brawlTagSchema.safeParse(player?.['tag'] ?? '');
    changes.push({
      detectedAt,
      eventType,
      playerName: asString(player?.['name']),
      playerTag: parsedTag.success ? parsedTag.data : null,
    });
  }

  return changes.slice(0, 10);
}

function historyPointFromSnapshot(snapshot: ClubSnapshot): HistoryPoint | null {
  if (Number.isNaN(Date.parse(snapshot.capturedAt))) return null;
  const members = parseApiMembers(record(snapshot.raw)?.['members']);
  const memberCount = asNumber(snapshot.memberCount) ?? (members.length > 0 ? members.length : null);

  return {
    capturedAt: snapshot.capturedAt,
    syncRunId: snapshot.syncRunId,
    trophies: asNumber(snapshot.trophies),
    averageTrophies: members.length > 0
      ? calculateAverage(members.map((member) => member.trophies))
      : null,
    memberCount,
  };
}

function progressionFor(
  snapshots: readonly ClubSnapshot[],
  currentTrophies: number | null,
  currentAt: string,
  now: Date,
  seasonStartIso: string | undefined,
): TrophyProgression | null {
  const currentAtMs = Date.parse(currentAt);
  if (currentTrophies === null || Number.isNaN(currentAtMs)) return null;

  const applicable = snapshots.filter((snapshot) => {
    const capturedMs = Date.parse(snapshot.capturedAt);
    return !Number.isNaN(capturedMs) && capturedMs <= currentAtMs;
  });

  return calculateTrophyProgression({
    snapshots: applicable,
    currentTrophies,
    currentAt,
    now,
    seasonStartIso,
  });
}

async function readSyncedClubView(
  club: ClubRecord,
  db: DatabaseClient,
): Promise<SyncedClubView> {
  const [snapshots, runs] = await Promise.all([readSnapshots(club.id, db), readCompletedRuns(db)]);
  const completedRunIds = new Set(runs.map((run) => run.id));
  const latestSnapshot = latestCompletedSnapshot(snapshots, completedRunIds);
  const snapshotRosterResult = snapshotRoster(snapshots, completedRunIds);
  const roster = snapshotRosterResult?.roster ?? (await readMembershipRoster(club.id, db));

  return {
    club,
    snapshots,
    completedRunIds,
    latestSnapshot,
    roster,
    rosterSource: snapshotRosterResult !== null ? 'snapshot' : (roster.length > 0 ? 'memberships' : 'none'),
    latestSyncAt: latestSuccessfulSyncAt(club, runs),
  };
}

export interface ClubReadOptions {
  readonly db?: DatabaseClient;
}

export interface ClubProgressionOptions extends ClubReadOptions {
  readonly now?: Date;
  readonly seasonStartIso?: string | undefined;
}

/** Load stored roster data for a registered club without contacting the API. */
export async function loadSyncedClub(
  input: { readonly tag?: string | undefined; readonly guildId?: string | null | undefined },
  options: ClubReadOptions = {},
): Promise<ResolvedClubResult<SyncedClubView>> {
  const db = options.db ?? createTrustedClient();
  const normalized = normalizeLookupTag(input.tag);
  if (!normalized.ok) return { kind: 'invalid-tag' };

  const club = await resolveClub({ tag: normalized.tag, guildId: input.guildId, db });
  const failure = clubLookupFailure(club, normalized.tag);
  if (failure !== null) return failure;
  if (club === null) return { kind: 'no-default' };

  return { kind: 'ok', value: await readSyncedClubView(club, db) };
}

async function enrichRoster(
  roster: readonly RosterMember[],
  db: DatabaseClient,
): Promise<MemberDetail[]> {
  const players = await readPlayersByTags(roster.map((member) => member.tag), db);
  const byTag = new Map(players.map((player) => [player.tag, player]));

  return roster.map((member) => ({
    ...member,
    playerId: byTag.get(member.tag)?.id ?? null,
    highestTrophies: byTag.get(member.tag)?.highestTrophies ?? null,
  }));
}

/** Load the latest synchronised roster with stored player details. */
export async function loadMemberView(
  input: { readonly tag?: string | undefined; readonly guildId?: string | null | undefined },
  options: ClubReadOptions = {},
): Promise<ResolvedClubResult<MemberView>> {
  const db = options.db ?? createTrustedClient();
  const base = await loadSyncedClub(input, { db });
  if (base.kind !== 'ok') return base;

  return {
    kind: 'ok',
    value: {
      ...base.value,
      members: sortMembersByTrophies(await enrichRoster(base.value.roster, db)),
    },
  };
}

/** Load a trophy leaderboard with snapshot-backed player progression. */
export async function loadLeaderboardView(
  input: {
    readonly tag?: string | undefined;
    readonly guildId?: string | null | undefined;
    readonly now?: Date;
    readonly seasonStartIso?: string | undefined;
  },
  options: ClubReadOptions = {},
): Promise<ResolvedClubResult<LeaderboardView>> {
  const db = options.db ?? createTrustedClient();
  const members = await loadMemberView(input, { db });
  if (members.kind !== 'ok') return members;

  const view = members.value;
  const now = input.now ?? new Date();
  const currentAt = view.latestSnapshot?.capturedAt ?? '';
  const entries = rankByTrophies(view.members);
  const snapshots = await readPlayerSnapshots(
    entries
      .map((entry) => entry.playerId)
      .filter((id): id is string => id !== null),
    view.completedRunIds,
    db,
  );
  const grouped = new Map<string, ClubSnapshot[]>();
  for (const row of snapshots) {
    const list = grouped.get(row.playerId) ?? [];
    list.push(row.snapshot);
    grouped.set(row.playerId, list);
  }

  const ranked: LeaderboardEntry[] = entries.map((entry) => ({
    ...entry,
    progression:
      entry.playerId === null || currentAt === ''
        ? null
        : progressionFor(
            grouped.get(entry.playerId) ?? [],
            entry.trophies,
            currentAt,
            now,
            input.seasonStartIso,
          ),
  }));

  return { kind: 'ok', value: { ...view, entries: ranked } };
}

/** Load stored club history for one bounded period. */
export async function loadHistoryView(
  input: {
    readonly tag?: string | undefined;
    readonly guildId?: string | null | undefined;
    readonly period: HistoryPeriod;
    readonly now?: Date;
    readonly seasonStartIso?: string | undefined;
  },
  options: ClubReadOptions = {},
): Promise<ResolvedClubResult<HistoryView>> {
  const db = options.db ?? createTrustedClient();
  const base = await loadSyncedClub(input, { db });
  if (base.kind !== 'ok') return base;

  const view = base.value;
  const now = input.now ?? new Date();
  const eligible = filterSnapshotsByPeriod(view.snapshots, input.period, now).filter((snapshot) =>
    view.completedRunIds.has(snapshot.syncRunId),
  );
  const points = eligible
    .map((snapshot) => historyPointFromSnapshot(snapshot))
    .filter((point): point is HistoryPoint => point !== null);
  const latest = points[points.length - 1] ?? null;
  const membershipChanges = await readMembershipEvents(view.club.id, input.period, now, db);

  return {
    kind: 'ok',
    value: {
      ...view,
      period: input.period,
      points,
      latestSnapshotAt: view.latestSnapshot?.capturedAt ?? null,
      rangeStart: points[0]?.capturedAt ?? null,
      rangeEnd: latest?.capturedAt ?? null,
      change: calculateHistoryChange(points),
      progression:
        latest === null
          ? null
          : progressionFor(
              eligible,
              latest.trophies,
              latest.capturedAt,
              now,
              input.seasonStartIso,
            ),
      membershipChanges,
    },
  };
}

function comparisonSnapshot(
  view: SyncedClubView,
  preferredRunId: string | null,
): ClubSnapshot | null {
  if (preferredRunId !== null) {
    return (
      view.snapshots.find(
        (snapshot) =>
          snapshot.syncRunId === preferredRunId && view.completedRunIds.has(snapshot.syncRunId),
      ) ?? null
    );
  }
  return view.latestSnapshot;
}

function rosterFromComparisonSnapshot(
  view: SyncedClubView,
  snapshot: ClubSnapshot | null,
): readonly RosterMember[] {
  if (snapshot === null) return view.roster;
  const roster = parseApiMembers(record(snapshot.raw)?.['members']);
  return roster.length > 0 ? roster : [];
}

function buildComparisonSide(
  view: SyncedClubView,
  snapshot: ClubSnapshot | null,
  now: Date,
  seasonStartIso: string | undefined,
): ComparisonSide {
  const roster = rosterFromComparisonSnapshot(view, snapshot);
  const range = calculateTrophyRange(roster);
  const currentAt = snapshot?.capturedAt ?? '';

  return {
    club: view.club,
    trophies: snapshot?.trophies ?? (snapshot === null ? view.club.trophies : null),
    averageTrophies: roster.length > 0
      ? calculateAverage(roster.map((member) => member.trophies))
      : null,
    memberCount:
      asNumber(snapshot?.memberCount) ??
      (roster.length > 0 ? roster.length : view.club.memberCount),
    highestTrophies: range?.high ?? null,
    lowestTrophies: range?.low ?? null,
    progression:
      snapshot === null
        ? null
        : progressionFor(
            view.snapshots.filter((candidate) => view.completedRunIds.has(candidate.syncRunId)),
            snapshot.trophies,
            currentAt,
            now,
            seasonStartIso,
          ),
    latestSyncAt: view.latestSyncAt,
    snapshotAt: currentAt === '' ? null : currentAt,
    syncRunId: snapshot?.syncRunId ?? null,
  };
}

function commonCompletedRunId(
  first: SyncedClubView,
  second: SyncedClubView,
): string | null {
  const firstRuns = new Set(
    first.snapshots
      .filter((snapshot) => first.completedRunIds.has(snapshot.syncRunId))
      .map((snapshot) => snapshot.syncRunId),
  );
  const shared = second.snapshots
    .filter(
      (snapshot) =>
        second.completedRunIds.has(snapshot.syncRunId) && firstRuns.has(snapshot.syncRunId),
    )
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));

  return shared[0]?.syncRunId ?? null;
}

/** Compare two registered clubs using their latest common completed snapshot. */
export async function loadCompareView(
  input: {
    readonly firstTag: string;
    readonly secondTag: string;
    readonly now?: Date;
    readonly seasonStartIso?: string | undefined;
  },
  options: ClubReadOptions = {},
): Promise<ResolvedClubResult<ComparisonView>> {
  const db = options.db ?? createTrustedClient();
  const first = normalizeLookupTag(input.firstTag);
  const second = normalizeLookupTag(input.secondTag);
  if (!first.ok || !second.ok || first.tag === undefined || second.tag === undefined) {
    return { kind: 'invalid-tag' };
  }
  if (first.tag === second.tag) return { kind: 'same-club' };

  const [firstClub, secondClub] = await Promise.all([
    findClubByTag(first.tag, db),
    findClubByTag(second.tag, db),
  ]);
  const firstFailure = clubLookupFailure(firstClub, first.tag);
  if (firstFailure !== null) return firstFailure;
  const secondFailure = clubLookupFailure(secondClub, second.tag);
  if (secondFailure !== null) return secondFailure;
  if (firstClub === null || secondClub === null) return { kind: 'same-club' };
  if (firstClub.id === secondClub.id) return { kind: 'same-club' };

  const [firstView, secondView] = await Promise.all([
    readSyncedClubView(firstClub, db),
    readSyncedClubView(secondClub, db),
  ]);
  const sharedRunId = commonCompletedRunId(firstView, secondView);
  const now = input.now ?? new Date();

  return {
    kind: 'ok',
    value: {
      first: buildComparisonSide(
        firstView,
        comparisonSnapshot(firstView, sharedRunId),
        now,
        input.seasonStartIso,
      ),
      second: buildComparisonSide(
        secondView,
        comparisonSnapshot(secondView, sharedRunId),
        now,
        input.seasonStartIso,
      ),
      aligned: sharedRunId !== null,
    },
  };
}
