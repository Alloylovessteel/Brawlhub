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
import { calculateGain, latestAcceptedSubmissions, rankPushRows } from './calculate';
import type {
  PushActorContext,
  PushClubRef,
  PushCompetitionRecord,
  PushEntry,
  PushJoinResult,
  PushLeaderboardRow,
  PushLeaderboardView,
  PushSubmitResult,
  PushSubmission,
  PushVerifiedPlayer,
} from './types';
import {
  isUuid,
  normalizePushDescription,
  normalizePushName,
  parsePushGoal,
  parsePushPeriod,
  parsePushTrophies,
  type ValidationResult,
} from './validate';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const COMPETITION_COLUMNS = [
  'id', 'name', 'rules', 'club_id', 'starts_at', 'ends_at', 'goal', 'status',
  'created_by', 'created_at', 'ended_by', 'ended_at',
  'club:clubs!competitions_club_id_fkey(id, tag, name)',
].join(', ');

const ENTRY_COLUMNS = [
  'id', 'competition_id', 'player_id', 'joined_at', 'baseline_trophies',
  'baseline_source', 'baseline_captured_at',
  'player:players!competition_entries_player_id_fkey(' +
    'id, tag, name, trophies, highest_trophies, exp_level, last_synced_at)',
].join(', ');

const SUBMISSION_COLUMNS = [
  'id', 'competition_id', 'entry_id', 'trophies', 'source', 'verification_status',
  'accepted', 'submitted_by_profile_id', 'submitted_at', 'verified_snapshot_id',
  'verified_by_profile_id',
].join(', ');

const ROLES: readonly Role[] = ['owner', 'admin', 'staff', 'member'];

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  forbidden: 'You do not have permission to manage push competitions.',
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

/** Expected, user-facing push failures; raw database errors remain hidden. */
export class PushServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PushServiceError';
  }
}

export interface PushServiceOptions {
  readonly db?: DatabaseClient;
  readonly now?: Date;
}

interface RpcResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly code?: string;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'That push competition action could not be completed.';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function parseClubRef(value: unknown): PushClubRef | null {
  const row = relationRecord(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const tag = asString(row['tag']);
  const name = asString(row['name']);
  if (id === null || tag === null || name === null) return null;
  return { id, tag, name };
}

function parseCompetitionRow(value: unknown, entryCount: number): PushCompetitionRecord | null {
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

function parseVerifiedPlayerRow(value: unknown): PushVerifiedPlayer | null {
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

function parseEntryRow(value: unknown): PushEntry | null {
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

function parseSubmissionRow(value: unknown): PushSubmission | null {
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
  throw new PushServiceError('invalid_input', result.message);
}

function requireUuid(value: string): void {
  if (!isUuid(value)) throw new PushServiceError('invalid_selection', errorMessage('invalid_selection'));
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

function expectOk(result: RpcResult): void {
  if (result['ok'] !== true) {
    const code = asString(result['code']) ?? 'unknown';
    throw new PushServiceError(code, errorMessage(code));
  }
}

/** Resolve a Discord snowflake to the BrawlHub profile and its stored roles. */
export async function resolvePushActor(
  discordUserId: string,
  options: PushServiceOptions = {},
): Promise<PushActorContext> {
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
    throw new PushServiceError('profile_not_linked', errorMessage('profile_not_linked'));
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
export function canManagePushCompetition(
  actor: PushActorContext,
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
export async function loadPushPlayer(
  playerId: string,
  options: PushServiceOptions = {},
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
  options: PushServiceOptions = {},
): Promise<PushVerifiedPlayer[]> {
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
    .filter((player): player is PushVerifiedPlayer => player !== null);
}

export async function hasVerifiedPlayerLink(
  profileId: string,
  playerId: string,
  options: PushServiceOptions = {},
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
  const { data, error } = await db
    .from('competition_entries')
    .select('id')
    .eq('competition_id', competitionId);
  requireOk(error, 'Read competition entries');
  return (data ?? []).length;
}

/** Load one competition with its club restriction and entry count. */
export async function loadPushCompetition(
  competitionId: string,
  options: PushServiceOptions = {},
): Promise<PushCompetitionRecord | null> {
  if (!isUuid(competitionId)) return null;
  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('competitions')
    .select(COMPETITION_COLUMNS)
    .eq('id', competitionId)
    .maybeSingle();
  requireOk(error, 'Read competition');
  if (data === null || data === undefined) return null;
  return parseCompetitionRow(data, await readEntryCount(db, competitionId));
}

/** List all competitions for the paginated `/push list` view. */
export async function listPushCompetitions(
  options: PushServiceOptions = {},
): Promise<PushCompetitionRecord[]> {
  const db = options.db ?? createTrustedClient();
  const [competitionsResult, entriesResult] = await Promise.all([
    db
      .from('competitions')
      .select(COMPETITION_COLUMNS)
      .order('starts_at', { ascending: false })
      .limit(500),
    db.from('competition_entries').select('competition_id').limit(10_000),
  ]);
  requireOk(competitionsResult.error, 'Read competitions');
  requireOk(entriesResult.error, 'Read competition entries');

  const counts = new Map<string, number>();
  for (const value of entriesResult.data ?? []) {
    const row = record(value);
    const competitionId = asString(row?.['competition_id']);
    if (competitionId === null) continue;
    counts.set(competitionId, (counts.get(competitionId) ?? 0) + 1);
  }

  return (competitionsResult.data ?? [])
    .map((value: unknown) => parseCompetitionRow(value, 0))
    .filter((competition): competition is PushCompetitionRecord => competition !== null)
    .map((competition) => ({
      ...competition,
      entryCount: counts.get(competition.id) ?? 0,
    }));
}

export async function createPushCompetition(
  input: PushCreateInputLike,
  options: PushServiceOptions = {},
): Promise<PushCompetitionRecord> {
  const name = normalizePushName(input.name);
  if (!name.ok) failValidation(name);
  const description = normalizePushDescription(input.description);
  if (!description.ok) failValidation(description);
  const period = parsePushPeriod(input.start, input.end, options.now ?? new Date());
  if (!period.ok) failValidation(period);
  const goal = parsePushGoal(input.goal);
  if (!goal.ok) failValidation(goal);
  if (input.clubId !== null) requireUuid(input.clubId);

  const actor = await resolvePushActor(input.discordUserId, options);
  if (!canManagePushCompetition(actor, input.clubId)) {
    throw new PushServiceError('forbidden', errorMessage('forbidden'));
  }

  const result = await runRpc(
    options.db ?? createTrustedClient(),
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
  if (competitionId === null) throw new PushServiceError('unknown', errorMessage('not_found'));
  const competition = await loadPushCompetition(competitionId, options);
  if (competition === null) throw new PushServiceError('not_found', errorMessage('not_found'));
  return competition;
}

export async function joinPushCompetition(
  input: PushJoinInputLike,
  options: PushServiceOptions = {},
): Promise<PushJoinResult> {
  requireUuid(input.competitionId);
  requireUuid(input.playerId);
  const actor = await resolvePushActor(input.discordUserId, options);
  if (!(await hasVerifiedPlayerLink(actor.profileId, input.playerId, options))) {
    throw new PushServiceError('not_verified', errorMessage('not_verified'));
  }

  const result = await runRpc(
    options.db ?? createTrustedClient(),
    'push_join_competition',
    {
      p_competition_id: input.competitionId,
      p_profile_id: actor.profileId,
      p_player_id: input.playerId,
    },
  );
  expectOk(result);

  const entryId = asString(result['id']);
  if (entryId === null) throw new PushServiceError('unknown', errorMessage('not_found'));
  const source = asString(result['baselineSource']) ?? 'none';
  return {
    entryId,
    baselineTrophies: asNumber(result['baselineTrophies']),
    baselineSource: source === 'player_snapshot' ? 'player_snapshot' : 'none',
    baselineCapturedAt: asString(result['baselineCapturedAt']),
  };
}

export async function submitPushResult(
  input: PushSubmitInputLike,
  options: PushServiceOptions = {},
): Promise<PushSubmitResult> {
  requireUuid(input.competitionId);
  requireUuid(input.playerId);
  const trophies = parsePushTrophies(input.trophies);
  if (!trophies.ok) failValidation(trophies);

  const actor = await resolvePushActor(input.discordUserId, options);
  if (!(await hasVerifiedPlayerLink(actor.profileId, input.playerId, options))) {
    throw new PushServiceError('not_verified', errorMessage('not_verified'));
  }

  const result = await runRpc(
    options.db ?? createTrustedClient(),
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
    throw new PushServiceError('unknown', 'The result could not be recorded.');
  }
  return {
    submissionId,
    submittedAt,
    trophies: recordedTrophies,
    verificationStatus: 'unverified',
  };
}

export async function endPushCompetition(
  input: PushEndInputLike,
  options: PushServiceOptions = {},
): Promise<PushCompetitionRecord> {
  requireUuid(input.competitionId);
  const actor = await resolvePushActor(input.discordUserId, options);
  const competition = await loadPushCompetition(input.competitionId, options);
  if (competition === null) throw new PushServiceError('not_found', errorMessage('not_found'));
  if (!canManagePushCompetition(actor, competition.clubId)) {
    throw new PushServiceError('forbidden', errorMessage('forbidden'));
  }

  const result = await runRpc(
    options.db ?? createTrustedClient(),
    'push_end_competition',
    {
      p_competition_id: input.competitionId,
      p_profile_id: actor.profileId,
    },
  );
  expectOk(result);

  const ended = await loadPushCompetition(input.competitionId, options);
  if (ended === null) throw new PushServiceError('not_found', errorMessage('not_found'));
  return ended;
}

/** Load entries and accepted submissions, then apply deterministic scoring. */
export async function loadPushLeaderboard(
  competitionId: string,
  options: PushServiceOptions = {},
): Promise<PushLeaderboardView> {
  const db = options.db ?? createTrustedClient();
  const competition = await loadPushCompetition(competitionId, options);
  if (competition === null) throw new PushServiceError('not_found', errorMessage('not_found'));

  const [entriesResult, submissionsResult] = await Promise.all([
    db
      .from('competition_entries')
      .select(ENTRY_COLUMNS)
      .eq('competition_id', competitionId)
      .order('joined_at', { ascending: true })
      .limit(1000),
    db
      .from('competition_submissions')
      .select(SUBMISSION_COLUMNS)
      .eq('competition_id', competitionId)
      .order('submitted_at', { ascending: false })
      .limit(10_000),
  ]);
  requireOk(entriesResult.error, 'Read competition entries');
  requireOk(submissionsResult.error, 'Read competition submissions');

  const entries = (entriesResult.data ?? [])
    .map((value: unknown) => parseEntryRow(value))
    .filter((entry): entry is PushEntry => entry !== null);
  const submissions = (submissionsResult.data ?? [])
    .map((value: unknown) => parseSubmissionRow(value))
    .filter((submission): submission is PushSubmission => submission !== null);
  const latest = latestAcceptedSubmissions(submissions);

  const unranked: Omit<PushLeaderboardRow, 'rank'>[] = entries.map((entry) => {
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
    rows: rankPushRows(unranked),
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

// Local aliases keep the exported input types in types.ts free of service details.
type PushCreateInputLike = import('./types').PushCreateInput;
type PushJoinInputLike = import('./types').PushJoinInput;
type PushSubmitInputLike = import('./types').PushSubmitInput;
type PushEndInputLike = import('./types').PushEndInput;
