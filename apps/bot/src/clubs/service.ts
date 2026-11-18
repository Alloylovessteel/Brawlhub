import {
  BrawlStarsApiError,
  createBrawlStarsClient,
  type BrawlStarsClient,
} from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { brawlTagSchema } from '@brawlhub/shared';
import { calculateAverage } from './calculate';
import type {
  ApiIssue,
  ClubRecord,
  ClubSnapshot,
  ClubSummary,
  ClubView,
  LoadClubResult,
  RosterMember,
  RosterSource,
  SyncRunRecord,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

interface LiveClubData {
  readonly trophies: number;
  readonly roster: RosterMember[];
  readonly description: string | null;
  readonly requiredTrophies: number | null;
}

interface LiveClubFetchResult {
  readonly data: LiveClubData | null;
  readonly issue: ApiIssue | null;
}

const LIVE_CLUB_CACHE_MS = 30_000;
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function relationRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return record(candidate);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function requireOk(error: { message?: string } | null | undefined, context: string): void {
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

function parseSyncRunRow(value: unknown): SyncRunRecord | null {
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

function parseSnapshotRow(value: unknown): ClubSnapshot | null {
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

function classifyApiError(error: unknown): ApiIssue {
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

async function readClubs(db: DatabaseClient): Promise<ClubRecord[]> {
  const { data, error } = await db
    .from('clubs')
    .select(CLUB_COLUMNS)
    .order('name', { ascending: true });
  requireOk(error, 'Read registered clubs');
  return (data ?? [])
    .map((row: unknown) => parseClubRow(row))
    .filter((row): row is ClubRecord => row !== null);
}

async function findClubByTag(tag: string, db: DatabaseClient): Promise<ClubRecord | null> {
  const { data, error } = await db
    .from('clubs')
    .select(CLUB_COLUMNS)
    .eq('tag', tag)
    .maybeSingle();
  requireOk(error, 'Read registered club');
  return parseClubRow(data);
}

async function findClubById(id: string, db: DatabaseClient): Promise<ClubRecord | null> {
  const { data, error } = await db
    .from('clubs')
    .select(CLUB_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  requireOk(error, 'Read default club');
  return parseClubRow(data);
}

async function readCompletedRuns(db: DatabaseClient): Promise<SyncRunRecord[]> {
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
    return findClubByTag(input.tag, input.db);
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
      const configured = await findClubById(primaryClubId, input.db);
      if (configured !== null) return configured;
    }
  }

  // With no guild default, an unambiguous single registered club is the default.
  const clubs = await readClubs(input.db);
  return clubs.length === 1 ? clubs[0] ?? null : null;
}

/** List registered clubs without contacting the Brawl Stars API. */
export async function getRegisteredClubs(
  db: DatabaseClient = createTrustedClient(),
): Promise<ClubRecord[]> {
  return readClubs(db);
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
  },
  options: ClubServiceOptions = {},
): Promise<LoadClubResult> {
  const db = options.db ?? createTrustedClient();
  const api = options.api ?? createBrawlStarsClient();
  const now = input.now ?? new Date();

  let normalizedTag: string | undefined;
  if (input.tag !== undefined && input.tag.trim() !== '') {
    const parsedTag = brawlTagSchema.safeParse(input.tag);
    if (!parsedTag.success) return { kind: 'invalid-tag' };
    normalizedTag = parsedTag.data;
  }

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
    liveStatus = 'live';
  }

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
