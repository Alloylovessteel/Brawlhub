import { createTrustedClient } from '@brawlhub/database';
import { hasPermission, type Role } from '@brawlhub/shared';
import {
  asNumber,
  asString,
  record,
  relationRecord,
  requireOk,
} from '../clubs/service';
import { parsePlayerRow } from '../players/service';
import type { PlayerIdentity } from '../players/types';
import { calculateGain, latestAcceptedSubmissions, rankCompetitionRows } from './calculate';
import type {
  CompetitionActorContext,
  CompetitionClubRef,
  CompetitionRecord,
  CompetitionEntry,
  CompetitionJoinResult,
  CompetitionLeaderboardRow,
  CompetitionLeaderboardView,
  CompetitionSubmitResult,
  CompetitionSubmission,
  CompetitionVerifiedPlayer,
} from './types';
import {
  isUuid,
  normalizeCompetitionDescription,
  normalizeCompetitionName,
  parseCompetitionGoal,
  parseCompetitionPeriod,
  parseCompetitionTrophies,
  type ValidationResult,
} from './validate';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const COMPETITION_COLUMNS = [
  'id', 'name', 'rules', 'club_id', 'starts_at', 'ends_at', 'goal', 'status',
  'created_by', 'created_at', 'ended_by', 'ended_at',
  'club:clubs!competitions_club_id_fkey(id, tag, name)',
].join(', ');

const STANDINGS_PAGE_SIZE = 1000;
const ENTRIES_PAGE_SIZE = 1000;
// Keyset pages always move strictly in one direction, so this only guards
// against a misbehaving RPC returning an endless stream of rows.
const MAX_STANDINGS_PAGES = 20;
const MAX_ENTRY_PAGES = 20;

const ROLES: readonly Role[] = ['owner', 'admin', 'staff', 'member'];

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  forbidden: 'You do not have permission to manage competitions.',
  duplicate: 'A competition with that name, club and time period already exists.',
  invalid_name: 'Competition names must be between 1 and 100 characters.',
  invalid_period: 'The competition end must be after the start, and the start cannot be in the past.',
  invalid_goal: 'Goal must be a positive whole number.',
  invalid_trophies: 'Trophies must be a whole number of 0 or more.',
  unknown_club: 'That club is not registered with BrawlHub.',
  not_found: 'That competition could not be found.',
  ended: 'That competition has already ended.',
  already_ended: 'That competition has already been ended.',
  already_joined: 'You are already entered in that competition with this account.',
  not_joined: 'Join the competition with this account before submitting a result.',
  not_verified: 'That Brawl Stars account is not verified to your Discord profile.',
  wrong_club: 'That Brawl Stars account is not an active member of the restricted club.',
  outside_period: 'Submissions are only accepted during the competition period.',
  profile_not_linked: 'Your Discord account is not linked to BrawlHub. Sign in to the website first.',
  invalid_selection: 'That selection is not valid.',
};

/** Expected, user-facing competition failures; raw database errors remain hidden. */
export class CompetitionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompetitionServiceError';
  }
}

export interface CompetitionServiceOptions {
  readonly db?: DatabaseClient;
  readonly now?: Date;
  readonly guildId?: string | null;
}

async function readGuildClubIds(guildId: string | null | undefined, db: DatabaseClient): Promise<string[] | null> {
  if (guildId === undefined || guildId === null || guildId.trim() === '') return null;
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

async function assertCompetitionInGuild(
  competition: CompetitionRecord | null,
  guildId: string | null | undefined,
  db: DatabaseClient,
): Promise<CompetitionRecord> {
  if (competition === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  if (guildId === undefined || guildId === null || guildId.trim() === '') return competition;
  // Global competitions (club_id NULL) are intentionally visible in every
  // guild; only club-scoped competitions require a matching guild club.
  if (competition.clubId === null) return competition;
  const guildClubIds = await readGuildClubIds(guildId, db);
  if (guildClubIds !== null && guildClubIds.includes(competition.clubId)) {
    return competition;
  }
  throw new CompetitionServiceError('not_found', errorMessage('not_found'));
}

interface RpcResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly code?: string;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'That competition action could not be completed.';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function parseClubRef(value: unknown): CompetitionClubRef | null {
  const row = relationRecord(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const tag = asString(row['tag']);
  const name = asString(row['name']);
  if (id === null || tag === null || name === null) return null;
  return { id, tag, name };
}

function parseCompetitionRow(value: unknown, entryCount: number): CompetitionRecord | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const name = asString(row['name']);
  const startsAt = asString(row['starts_at']);
  const endsAt = asString(row['ends_at']);
  const status = asString(row['status']);
  const createdAt = asString(row['created_at']);
  if (
    id === null || name === null || startsAt === null || endsAt === null ||
    status === null || createdAt === null
  ) {
    return null;
  }

  return {
    id,
    name,
    description: asString(row['rules']),
    clubId: asString(row['club_id']),
    club: parseClubRef(row['club']),
    startsAt,
    endsAt,
    goal: asNumber(row['goal']),
    status,
    createdBy: asString(row['created_by']),
    createdAt,
    endedBy: asString(row['ended_by']),
    endedAt: asString(row['ended_at']),
    entryCount,
  };
}

function parseVerifiedPlayerRow(value: unknown): CompetitionVerifiedPlayer | null {
  const row = record(value);
  if (row === null) return null;
  const player = parsePlayerRow(relationRecord(row['player']) ?? row['player']);
  if (player === null || player.id === null) return null;
  const verifiedAt = asString(row['verified_at']);
  const method = asString(row['method']);
  if (verifiedAt === null || method === null) return null;

  return {
    id: player.id,
    tag: player.tag,
    name: player.name,
    verifiedAt,
    method,
  };
}

function parseEntryRow(value: unknown): CompetitionEntry | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const competitionId = asString(row['competition_id']);
  const joinedAt = asString(row['joined_at']);
  const player = parsePlayerRow(relationRecord(row['player']) ?? row['player']);
  const source = asString(row['baseline_source']) ?? 'none';
  if (id === null || competitionId === null || joinedAt === null || player === null) return null;

  return {
    id,
    competitionId,
    player,
    joinedAt,
    baselineTrophies: asNumber(row['baseline_trophies']),
    baselineSource:
      source === 'player_snapshot' || source === 'manual_verified' ? source : 'none',
    baselineCapturedAt: asString(row['baseline_captured_at']),
  };
}

function parseSubmissionRow(value: unknown): CompetitionSubmission | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const competitionId = asString(row['competition_id']);
  const entryId = asString(row['entry_id']);
  const trophies = asNumber(row['trophies']);
  const source = asString(row['source']);
  const verificationStatus = asString(row['verification_status']);
  const submittedAt = asString(row['submitted_at']);
  if (
    id === null || competitionId === null || entryId === null || trophies === null ||
    (source !== 'user' && source !== 'api') ||
    (verificationStatus !== 'unverified' && verificationStatus !== 'verified') ||
    submittedAt === null
  ) {
    return null;
  }

  return {
    id,
    competitionId,
    entryId,
    trophies,
    source,
    verificationStatus,
    accepted: asBoolean(row['accepted']),
    submittedByProfileId: asString(row['submitted_by_profile_id']),
    submittedAt,
    verifiedSnapshotId: asString(row['verified_snapshot_id']),
    verifiedByProfileId: asString(row['verified_by_profile_id']),
  };
}

function failValidation(result: ValidationResult<unknown>): never {
  if (result.ok) throw new Error('Expected a failed validation result');
  throw new CompetitionServiceError('invalid_input', result.message);
}

function requireUuid(value: string): void {
  if (!isUuid(value)) throw new CompetitionServiceError('invalid_selection', errorMessage('invalid_selection'));
}

async function runRpc(
  db: DatabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const { data, error } = await db.rpc(name, args);
  requireOk(error, name);
  return record(data) ?? {};
}

/** Read a table-valued RPC (PostgREST returns an array of rows). */
async function readRpcRows(
  db: DatabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  const { data, error } = await db.rpc(name, args);
  requireOk(error, name);
  return Array.isArray(data) ? data : [];
}

function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function expectOk(result: RpcResult): void {
  if (result['ok'] !== true) {
    const code = asString(result['code']) ?? 'unknown';
    throw new CompetitionServiceError(code, errorMessage(code));
  }
}

/** Resolve a Discord snowflake to the BrawlHub profile and its stored roles. */
export async function resolveCompetitionActor(
  discordUserId: string,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionActorContext> {
  const db = options.db ?? createTrustedClient();
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, discord_user_id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  requireOk(profileError, 'Read profile');

  const profileRow = record(profile);
  const profileId = asString(profileRow?.['id']);
  if (profileRow === null || profileId === null) {
    throw new CompetitionServiceError('profile_not_linked', errorMessage('profile_not_linked'));
  }

  const { data: roleRows, error: roleError } = await db
    .from('user_roles')
    .select('scope, club_id, role')
    .eq('user_id', profileId);
  requireOk(roleError, 'Read user roles');

  let globalRole: Role | null = null;
  const clubRoles = new Map<string, Role>();
  for (const value of roleRows ?? []) {
    const row = record(value);
    if (row === null || !isRole(row['role'])) continue;
    const role = row['role'];
    if (row['scope'] === 'global') {
      if (globalRole === null || ROLES.indexOf(role) > ROLES.indexOf(globalRole)) {
        globalRole = role;
      }
    } else if (row['scope'] === 'club') {
      const clubId = asString(row['club_id']);
      if (clubId === null) continue;
      const existing = clubRoles.get(clubId);
      if (existing === undefined || ROLES.indexOf(role) > ROLES.indexOf(existing)) {
        clubRoles.set(clubId, role);
      }
    }
  }

  return { profileId, discordUserId, globalRole, clubRoles };
}

/** Staff authorization uses stored roles and the shared permission matrix. */
export function canManageCompetition(
  actor: CompetitionActorContext,
  clubId: string | null,
): boolean {
  if (actor.globalRole !== null && hasPermission(actor.globalRole, 'competitions:manage')) {
    return true;
  }
  if (clubId === null) return false;
  const role = actor.clubRoles.get(clubId);
  return role !== undefined && hasPermission(role, 'competitions:manage');
}

/** Load a stored Brawl Stars player for confirmation embeds. */
export async function loadCompetitionPlayer(
  playerId: string,
  options: CompetitionServiceOptions = {},
): Promise<PlayerIdentity | null> {
  if (!isUuid(playerId)) return null;
  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('players')
    .select('id, tag, name, trophies, highest_trophies, exp_level, last_synced_at')
    .eq('id', playerId)
    .maybeSingle();
  requireOk(error, 'Read player');
  return data === null || data === undefined ? null : parsePlayerRow(data);
}

/** Verified accounts owned by the interacting Discord profile. */
export async function listVerifiedPlayers(
  profileId: string,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionVerifiedPlayer[]> {
  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('player_verifications')
    .select(
      'player_id, verified_at, method, ' +
      'player:players!player_verifications_player_id_fkey(id, tag, name, trophies, highest_trophies, exp_level, last_synced_at)',
    )
    .eq('profile_id', profileId)
    .eq('status', 'active')
    .order('verified_at', { ascending: false })
    .limit(25);
  requireOk(error, 'Read verified players');

  return (data ?? [])
    .map((value: unknown) => parseVerifiedPlayerRow(value))
    .filter((player): player is CompetitionVerifiedPlayer => player !== null);
}

export async function hasVerifiedPlayerLink(
  profileId: string,
  playerId: string,
  options: CompetitionServiceOptions = {},
): Promise<boolean> {
  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('player_verifications')
    .select('id')
    .eq('profile_id', profileId)
    .eq('player_id', playerId)
    .eq('status', 'active')
    .limit(1);
  requireOk(error, 'Read player verification');
  return (data ?? []).length > 0;
}

async function readEntryCount(db: DatabaseClient, competitionId: string): Promise<number> {
  // A table read would be capped by PostgREST; the SQL aggregate is exact.
  const rows = await readRpcRows(db, 'push_competition_entry_counts', {
    p_competition_ids: [competitionId],
  });
  for (const value of rows) {
    const row = record(value);
    if (asString(row?.['competition_id']) === competitionId) return asCount(row?.['count']);
  }
  return 0;
}

/**
 * Ask the database to recompute join-time baselines once the competition has
 * started. The RPC is idempotent: it preserves baselines once a result has
 * been accepted, so ignoring its result is safe on later reads.
 */
async function finalizeBaselinesIfStarted(
  competition: CompetitionRecord,
  db: DatabaseClient,
  now: Date,
): Promise<void> {
  const startsAt = Date.parse(competition.startsAt);
  if (Number.isNaN(startsAt) || now.getTime() < startsAt) return;
  await runRpc(db, 'push_finalize_competition_baselines', {
    p_competition_id: competition.id,
  });
}

/** Load one competition with its club restriction and entry count. */
export async function loadCompetitionRecord(
  competitionId: string,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionRecord | null> {
  if (!isUuid(competitionId)) return null;
  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('competitions')
    .select(COMPETITION_COLUMNS)
    .eq('id', competitionId)
    .maybeSingle();
  requireOk(error, 'Read competition');
  if (data === null || data === undefined) return null;
  const competition = parseCompetitionRow(data, await readEntryCount(db, competitionId));
  if (competition === null) return null;
  if (
    competition.clubId !== null &&
    options.guildId !== undefined &&
    options.guildId !== null &&
    options.guildId.trim() !== ''
  ) {
    const guildClubIds = await readGuildClubIds(options.guildId, db);
    if (guildClubIds === null || !guildClubIds.includes(competition.clubId)) return null;
  }
  return competition;
}

/** List all competitions for the paginated `/competition list` view. */
export async function listCompetitions(
  options: CompetitionServiceOptions = {},
): Promise<CompetitionRecord[]> {
  const db = options.db ?? createTrustedClient();
  const guildClubIds = await readGuildClubIds(options.guildId, db);
  const competitionQueries: Array<
    Promise<{ data: unknown[] | null; error: { message?: string } | null | undefined }>
  > = [];
  if (guildClubIds !== null && guildClubIds.length > 0) {
    competitionQueries.push(
      (async () =>
        db
          .from('competitions')
          .select(COMPETITION_COLUMNS)
          .order('starts_at', { ascending: false })
          .limit(500)
          .in('club_id', guildClubIds))(),
    );
  }
  // Global competitions have no club_id and are visible to every guild.
  competitionQueries.push(
    (async () =>
      db
        .from('competitions')
        .select(COMPETITION_COLUMNS)
        .order('starts_at', { ascending: false })
        .limit(500)
        .is('club_id', null))(),
  );

  const competitionResults = await Promise.all(competitionQueries);
  const competitionRows: unknown[] = [];
  for (const result of competitionResults) {
    requireOk(result.error, 'Read competitions');
    for (const value of result.data ?? []) {
      competitionRows.push(value);
    }
  }

  const parsed = competitionRows
    .map((value: unknown) => parseCompetitionRow(value, 0))
    .filter((competition): competition is CompetitionRecord => competition !== null);
  const competitionIds = [...new Set(parsed.map((competition) => competition.id))];

  // Counts are aggregated in SQL for exactly the guild-scoped ids returned
  // above; a single unscoped REST response would be truncated at 1000 rows.
  const counts = new Map<string, number>();
  if (competitionIds.length > 0) {
    const countRows = await readRpcRows(db, 'push_competition_entry_counts', {
      p_competition_ids: competitionIds,
    });
    for (const value of countRows) {
      const row = record(value);
      const competitionId = asString(row?.['competition_id']);
      if (competitionId === null) continue;
      counts.set(competitionId, asCount(row?.['count']));
    }
  }

  return parsed
    .map((competition) => ({
      ...competition,
      entryCount: counts.get(competition.id) ?? 0,
    }))
    .sort((left, right) => right.startsAt.localeCompare(left.startsAt));
}

export async function createCompetition(
  input: CompetitionCreateInputLike,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionRecord> {
  const name = normalizeCompetitionName(input.name);
  if (!name.ok) failValidation(name);
  const description = normalizeCompetitionDescription(input.description);
  if (!description.ok) failValidation(description);
  const period = parseCompetitionPeriod(input.start, input.end, options.now ?? new Date());
  if (!period.ok) failValidation(period);
  const goal = parseCompetitionGoal(input.goal);
  if (!goal.ok) failValidation(goal);
  if (input.clubId !== null) requireUuid(input.clubId);
  const db = options.db ?? createTrustedClient();
  if (options.guildId !== undefined && options.guildId !== null && options.guildId.trim() !== '') {
    if (input.clubId === null) {
      throw new CompetitionServiceError('unknown_club', 'Choose a registered club in this server for the competition.');
    }
    const guildClubIds = await readGuildClubIds(options.guildId, db);
    if (guildClubIds === null || !guildClubIds.includes(input.clubId)) {
      throw new CompetitionServiceError('unknown_club', errorMessage('unknown_club'));
    }
  }

  const actor = await resolveCompetitionActor(input.discordUserId, { ...options, db });
  if (!canManageCompetition(actor, input.clubId)) {
    throw new CompetitionServiceError('forbidden', errorMessage('forbidden'));
  }

  const result = await runRpc(
    db,
    'push_create_competition',
    {
      p_name: name.value,
      p_description: description.value,
      p_starts_at: period.value.startsAt,
      p_ends_at: period.value.endsAt,
      p_club_id: input.clubId,
      p_goal: goal.value,
      p_created_by: actor.profileId,
    },
  );
  expectOk(result);

  const competitionId = asString(result['id']);
  if (competitionId === null) throw new CompetitionServiceError('unknown', errorMessage('not_found'));
  const competition = await loadCompetitionRecord(competitionId, { ...options, db });
  if (competition === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  return competition;
}

export async function joinCompetition(
  input: CompetitionJoinInputLike,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionJoinResult> {
  requireUuid(input.competitionId);
  requireUuid(input.playerId);
  const db = options.db ?? createTrustedClient();
  if (options.guildId !== undefined && options.guildId !== null && options.guildId.trim() !== '') {
    const competition = await loadCompetitionRecord(input.competitionId, { ...options, db });
    if (competition === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  }
  const actor = await resolveCompetitionActor(input.discordUserId, { ...options, db });
  if (!(await hasVerifiedPlayerLink(actor.profileId, input.playerId, { ...options, db }))) {
    throw new CompetitionServiceError('not_verified', errorMessage('not_verified'));
  }

  const result = await runRpc(
    db,
    'push_join_competition',
    {
      p_competition_id: input.competitionId,
      p_profile_id: actor.profileId,
      p_player_id: input.playerId,
    },
  );
  expectOk(result);

  const entryId = asString(result['id']);
  if (entryId === null) throw new CompetitionServiceError('unknown', errorMessage('not_found'));
  const source = asString(result['baselineSource']) ?? 'none';
  return {
    entryId,
    baselineTrophies: asNumber(result['baselineTrophies']),
    baselineSource: source === 'player_snapshot' ? 'player_snapshot' : 'none',
    baselineCapturedAt: asString(result['baselineCapturedAt']),
  };
}

export async function submitCompetitionResult(
  input: CompetitionSubmitInputLike,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionSubmitResult> {
  requireUuid(input.competitionId);
  requireUuid(input.playerId);
  const trophies = parseCompetitionTrophies(input.trophies);
  if (!trophies.ok) failValidation(trophies);

  const db = options.db ?? createTrustedClient();
  // Always load the competition: loadCompetitionRecord also enforces the guild
  // restriction, and its start time decides whether baselines need finalizing.
  const competition = await loadCompetitionRecord(input.competitionId, { ...options, db });
  if (competition === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  const actor = await resolveCompetitionActor(input.discordUserId, { ...options, db });
  if (!(await hasVerifiedPlayerLink(actor.profileId, input.playerId, { ...options, db }))) {
    throw new CompetitionServiceError('not_verified', errorMessage('not_verified'));
  }
  await finalizeBaselinesIfStarted(competition, db, options.now ?? new Date());

  const result = await runRpc(
    db,
    'push_submit_result',
    {
      p_competition_id: input.competitionId,
      p_profile_id: actor.profileId,
      p_player_id: input.playerId,
      p_trophies: trophies.value,
    },
  );
  expectOk(result);

  const submissionId = asString(result['id']);
  const submittedAt = asString(result['submittedAt']);
  const recordedTrophies = asNumber(result['trophies']);
  if (submissionId === null || submittedAt === null || recordedTrophies === null) {
    throw new CompetitionServiceError('unknown', 'The result could not be recorded.');
  }
  return {
    submissionId,
    submittedAt,
    trophies: recordedTrophies,
    verificationStatus: 'unverified',
  };
}

export async function endCompetition(
  input: CompetitionEndInputLike,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionRecord> {
  requireUuid(input.competitionId);
  const db = options.db ?? createTrustedClient();
  const actor = await resolveCompetitionActor(input.discordUserId, { ...options, db });
  const competition = await loadCompetitionRecord(input.competitionId, { ...options, db });
  if (competition === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  if (!canManageCompetition(actor, competition.clubId)) {
    throw new CompetitionServiceError('forbidden', errorMessage('forbidden'));
  }

  const result = await runRpc(
    db,
    'push_end_competition',
    {
      p_competition_id: input.competitionId,
      p_profile_id: actor.profileId,
    },
  );
  expectOk(result);

  const ended = await loadCompetitionRecord(input.competitionId, { ...options, db });
  if (ended === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  return ended;
}

/** Load entries and accepted submissions, then apply deterministic scoring. */
export async function loadCompetitionLeaderboard(
  competitionId: string,
  options: CompetitionServiceOptions = {},
): Promise<CompetitionLeaderboardView> {
  const db = options.db ?? createTrustedClient();
  const competition = await loadCompetitionRecord(competitionId, options);
  if (competition === null) throw new CompetitionServiceError('not_found', errorMessage('not_found'));
  await finalizeBaselinesIfStarted(competition, db, options.now ?? new Date());

  // Entries are read through the bounded RPC so a competition with more than
  // one PostgREST page of entrants cannot silently lose its tail.
  const entries: CompetitionEntry[] = [];
  let entryCursor: { joinedAt: string; id: string } | null = null;
  const seenEntryCursors = new Set<string>();
  for (let page = 0; page < MAX_ENTRY_PAGES; page += 1) {
    const rows = await readRpcRows(db, 'push_competition_entries', {
      p_competition_id: competitionId,
      p_limit: ENTRIES_PAGE_SIZE,
      ...(entryCursor === null
        ? {}
        : { p_after_joined_at: entryCursor.joinedAt, p_after_id: entryCursor.id }),
    });
    for (const value of rows) {
      const entry = parseEntryRow(value);
      if (entry !== null) entries.push(entry);
    }
    if (rows.length < ENTRIES_PAGE_SIZE) break;
    const lastRow = record(rows[rows.length - 1]);
    const joinedAt = asString(lastRow?.['joined_at']);
    const lastId = asString(lastRow?.['id']);
    if (joinedAt === null || lastId === null) break;
    const cursorKey = `${joinedAt}\u0000${lastId}`;
    if (seenEntryCursors.has(cursorKey)) break;
    seenEntryCursors.add(cursorKey);
    entryCursor = { joinedAt, id: lastId };
  }

  // The RPC ranks accepted submissions per entry in SQL before keyset paging,
  // so a burst of newer rows cannot crowd out another entrant's only result.
  const submissions: CompetitionSubmission[] = [];
  let cursor: { submittedAt: string; id: string } | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_STANDINGS_PAGES; page += 1) {
    const rows = await readRpcRows(db, 'push_competition_standings', {
      p_competition_id: competitionId,
      p_limit: STANDINGS_PAGE_SIZE,
      ...(cursor === null
        ? {}
        : { p_after_submitted_at: cursor.submittedAt, p_after_id: cursor.id }),
    });
    for (const value of rows) {
      const submission = parseSubmissionRow(value);
      if (submission !== null) submissions.push(submission);
    }
    if (rows.length < STANDINGS_PAGE_SIZE) break;
    const lastRow = record(rows[rows.length - 1]);
    const submittedAt = asString(lastRow?.['submitted_at']);
    const lastId = asString(lastRow?.['id']);
    if (submittedAt === null || lastId === null) break;
    const cursorKey = `${submittedAt}\u0000${lastId}`;
    if (seenCursors.has(cursorKey)) break;
    seenCursors.add(cursorKey);
    cursor = { submittedAt, id: lastId };
  }

  const latest = latestAcceptedSubmissions(submissions);

  const unranked: Omit<CompetitionLeaderboardRow, 'rank'>[] = entries.map((entry) => {
    const submission = latest.get(entry.id) ?? null;
    const trophies = submission?.trophies ?? null;
    return {
      entry,
      trophies,
      gain: trophies === null ? null : calculateGain(trophies, entry.baselineTrophies),
      latestSubmissionAt: submission?.submittedAt ?? null,
      verificationStatus: submission?.verificationStatus ?? null,
    };
  });

  return {
    competition,
    rows: rankCompetitionRows(unranked),
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

// Local aliases keep the exported input types in types.ts free of service details.
type CompetitionCreateInputLike = import('./types').CompetitionCreateInput;
type CompetitionJoinInputLike = import('./types').CompetitionJoinInput;
type CompetitionSubmitInputLike = import('./types').CompetitionSubmitInput;
type CompetitionEndInputLike = import('./types').CompetitionEndInput;
