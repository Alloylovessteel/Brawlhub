import { createTrustedClient } from '@brawlhub/database';
import { brawlTagSchema, discordIdSchema, hasPermission, type Role } from '@brawlhub/shared';
import { asString, record, requireOk } from '../clubs/service';
import { parsePlayerRow } from '../players/service';
import type {
  AddBlacklistInput,
  AddBlacklistResult,
  BlacklistEntry,
  BlacklistListView,
  BlacklistTarget,
  ListBlacklistsInput,
  ModerationActor,
  ModerationServiceOptions,
  RemoveBlacklistInput,
  RemoveBlacklistResult,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const ROLES: readonly Role[] = ['owner', 'admin', 'staff', 'member'];

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  forbidden: 'You do not have permission to manage blacklists.',
  profile_not_linked: 'Your Discord account is not linked to BrawlHub. Sign in to the website first.',
  invalid_discord_id: 'Enter a valid Discord ID.',
  'invalid-tag': 'Enter a valid Brawl Stars player tag.',
  'player-not-found': 'That player is not tracked by BrawlHub yet. Run a sync first.',
  'invalid-reason': 'Reasons must be between 1 and 500 characters.',
  invalid_target: 'That player cannot be added to the blacklist.',
  invalid_reason: 'Reasons must be between 1 and 500 characters.',
  unknown_player: 'That player is not tracked by BrawlHub yet. Run a sync first.',
  duplicate_active: 'That player is already on the active blacklist.',
  not_found: 'That blacklist entry could not be found.',
  already_removed: 'That blacklist entry has already been removed.',
  unknown: 'That moderation action could not be completed.',
};

/** Expected, user-facing moderation failures; raw database errors remain hidden. */
export class ModerationServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModerationServiceError';
    this.code = code;
  }
}

declare module './types' {
  interface ListBlacklistsInput {
    readonly page?: number;
    readonly limit?: number;
    readonly offset?: number;
  }

  interface BlacklistListView {
    /** Total matching rows across every page, reported by the database RPC. */
    readonly total?: number;
  }
}

interface RpcResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly code?: string;
}

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES['unknown'] ?? 'That moderation action could not be completed.';
}

function fail(code: string): never {
  throw new ModerationServiceError(code, errorMessage(code));
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function dbFor(options: ModerationServiceOptions): DatabaseClient {
  return options.db ?? createTrustedClient();
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
    fail(asString(result['code']) ?? 'unknown');
  }
}

function normalizeAddReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return 'No reason provided';
  if (trimmed.length > 500) fail('invalid-reason');
  return trimmed;
}

function normalizeRemovalReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 500) fail('invalid-reason');
  return trimmed;
}

/** Resolve a Discord snowflake to the BrawlHub profile and its global role only. */
export async function resolveModerationActor(
  discordUserId: string,
  options: ModerationServiceOptions = {},
): Promise<ModerationActor> {
  const parsed = discordIdSchema.safeParse(discordUserId);
  if (!parsed.success) fail('invalid_discord_id');

  const db = dbFor(options);
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, discord_user_id')
    .eq('discord_user_id', parsed.data)
    .maybeSingle();
  requireOk(profileError, 'Read profile');

  const profileRow = record(profile);
  const profileId = asString(profileRow?.['id']);
  if (profileRow === null || profileId === null) fail('profile_not_linked');

  const { data: roleRows, error: roleError } = await db
    .from('user_roles')
    .select('scope, club_id, role')
    .eq('user_id', profileId);
  requireOk(roleError, 'Read user roles');

  let globalRole: Role | null = null;
  for (const value of roleRows ?? []) {
    const row = record(value);
    if (row === null || row['scope'] !== 'global' || !isRole(row['role'])) continue;
    const role = row['role'];
    if (globalRole === null || ROLES.indexOf(role) > ROLES.indexOf(globalRole)) {
      globalRole = role;
    }
  }

  return { profileId, discordUserId: parsed.data, globalRole };
}

/**
 * Blacklists are global-only. Club roles (and global staff) never grant this
 * permission; only the shared global permission matrix is consulted.
 */
export function canManageBlacklists(actor: ModerationActor): boolean {
  return actor.globalRole !== null && hasPermission(actor.globalRole, 'blacklists:manage');
}

/** Load a stored player for moderation; never calls the live API or inserts rows. */
export async function resolveBlacklistTarget(
  rawTag: string,
  options: ModerationServiceOptions = {},
): Promise<BlacklistTarget> {
  const parsed = brawlTagSchema.safeParse(rawTag);
  if (!parsed.success) fail('invalid-tag');

  const db = dbFor(options);
  const { data, error } = await db
    .from('players')
    .select('id, tag, name')
    .eq('tag', parsed.data)
    .maybeSingle();
  requireOk(error, 'Read player');

  const player = parsePlayerRow(data);
  if (player === null || player.id === null) fail('player-not-found');
  return { id: player.id, tag: player.tag, name: player.name };
}

export async function addBlacklist(
  input: AddBlacklistInput,
  options: ModerationServiceOptions = {},
): Promise<AddBlacklistResult> {
  const actor = await resolveModerationActor(input.discordUserId, options);
  if (!canManageBlacklists(actor)) fail('forbidden');

  const player = await resolveBlacklistTarget(input.tag, options);
  const reason = normalizeAddReason(input.reason);

  const result = await runRpc(dbFor(options), 'moderation_blacklist_add', {
    p_player_id: player.id,
    p_reason: reason,
    p_expires_at: null,
    p_actor_profile_id: actor.profileId,
    p_actor_discord_id: actor.discordUserId,
  });
  expectOk(result);

  const id = asString(result['id']);
  if (id === null) fail('unknown');
  const createdAt =
    asString(result['created_at']) ?? asString(result['createdAt']) ?? new Date().toISOString();
  return { id, player, reason, createdAt };
}

export async function removeBlacklist(
  input: RemoveBlacklistInput,
  options: ModerationServiceOptions = {},
): Promise<RemoveBlacklistResult> {
  const actor = await resolveModerationActor(input.discordUserId, options);
  if (!canManageBlacklists(actor)) fail('forbidden');

  const removalReason = normalizeRemovalReason(input.reason);

  const result = await runRpc(dbFor(options), 'moderation_blacklist_remove', {
    p_blacklist_id: input.blacklistId,
    p_removal_reason: removalReason,
    p_actor_profile_id: actor.profileId,
    p_actor_discord_id: actor.discordUserId,
  });
  expectOk(result);

  const id = asString(result['id']);
  const removedAt = asString(result['removedAt']) ?? asString(result['removed_at']);
  if (id === null || removedAt === null) fail('unknown');
  return { id, removedAt };
}

function normalizeBlacklistEntry(value: unknown): BlacklistEntry | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const reason = asString(row['reason']);
  const createdAt = asString(row['createdAt']) ?? asString(row['created_at']);
  if (id === null || reason === null || createdAt === null) return null;
  return {
    id,
    playerId: asString(row['playerId']) ?? asString(row['player_id']),
    playerTag: asString(row['playerTag']) ?? asString(row['player_tag']),
    playerName: asString(row['playerName']) ?? asString(row['player_name']),
    reason,
    createdByProfileId:
      asString(row['createdByProfileId']) ?? asString(row['created_by']),
    createdByDiscordId:
      asString(row['createdByDiscordId']) ?? asString(row['created_by_discord_id']),
    createdAt,
    expiresAt: asString(row['expiresAt']) ?? asString(row['expires_at']),
    removedAt: asString(row['removedAt']) ?? asString(row['removed_at']),
  };
}

function normalizeBlacklistPage(input: ListBlacklistsInput): { limit: number; offset: number } {
  const requestedLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : 100;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const requestedOffset =
    typeof input.offset === 'number' && Number.isFinite(input.offset)
      ? Math.floor(input.offset)
      : null;
  if (requestedOffset !== null) return { limit, offset: Math.max(0, requestedOffset) };
  const page =
    typeof input.page === 'number' && Number.isFinite(input.page)
      ? Math.floor(input.page)
      : 1;
  return { limit, offset: Math.max(0, page - 1) * limit };
}

/**
 * Read one filtered blacklist page from the trusted RPC. Searching, ordering,
 * counting and identity joins all happen in the database before the page is
 * returned, so no capped in-memory identity reads can distort the result.
 */
export async function listActiveBlacklists(
  input: ListBlacklistsInput,
  options: ModerationServiceOptions = {},
): Promise<BlacklistListView> {
  const actorDiscordUserId = options.actorDiscordUserId;
  if (actorDiscordUserId === undefined || actorDiscordUserId.trim() === '') fail('forbidden');

  const actor = await resolveModerationActor(actorDiscordUserId, options);
  if (!canManageBlacklists(actor)) fail('forbidden');

  const { limit, offset } = normalizeBlacklistPage(input);
  const result = await runRpc(dbFor(options), 'moderation_blacklist_list', {
    p_actor_profile_id: actor.profileId,
    p_actor_discord_id: actor.discordUserId,
    p_search: input.search ?? null,
    p_limit: limit,
    p_offset: offset,
  });
  expectOk(result);

  const entries = (Array.isArray(result['entries']) ? result['entries'] : [])
    .map(normalizeBlacklistEntry)
    .filter((entry): entry is BlacklistEntry => entry !== null);
  const total =
    typeof result['total'] === 'number' && Number.isFinite(result['total'])
      ? result['total']
      : entries.length;
  return { entries, total, generatedAt: new Date() };
}
