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

function parsePlayerIdentity(value: unknown): { readonly tag: string; readonly name: string } | null {
  const player = parsePlayerRow(value);
  if (player === null) return null;
  return { tag: player.tag, name: player.name };
}

/**
 * Read active blacklists and join player/creator identity in memory. The trusted
 * client is required because blacklist RLS only exposes rows to global admins.
 */
export async function listActiveBlacklists(
  input: ListBlacklistsInput,
  options: ModerationServiceOptions = {},
): Promise<BlacklistListView> {
  const actorDiscordUserId = options.actorDiscordUserId;
  if (actorDiscordUserId === undefined || actorDiscordUserId.trim() === '') fail('forbidden');

  const actor = await resolveModerationActor(actorDiscordUserId, options);
  if (!canManageBlacklists(actor)) fail('forbidden');

  const db = dbFor(options);
  const [blacklistsResult, profilesResult, playersResult, discordUsersResult] = await Promise.all([
    db
      .from('blacklists')
      .select('id, player_id, reason, created_by, expires_at, created_at, status')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(500),
    db.from('profiles').select('id, discord_user_id'),
    db.from('players').select('id, tag, name'),
    db.from('discord_users').select('discord_user_id, username'),
  ]);
  requireOk(blacklistsResult.error, 'Read blacklists');
  requireOk(profilesResult.error, 'Read profiles');
  requireOk(playersResult.error, 'Read players');
  requireOk(discordUsersResult.error, 'Read Discord users');

  const creatorDiscordIds = new Map<string, string>();
  for (const value of profilesResult.data ?? []) {
    const row = record(value);
    const id = asString(row?.['id']);
    const discordUserId = asString(row?.['discord_user_id']);
    if (id !== null && discordUserId !== null) creatorDiscordIds.set(id, discordUserId);
  }

  const playersById = new Map<string, { readonly tag: string; readonly name: string }>();
  for (const value of playersResult.data ?? []) {
    const row = record(value);
    const id = asString(row?.['id']);
    const identity = parsePlayerIdentity(row);
    if (id !== null && identity !== null) playersById.set(id, identity);
  }

  const usernamesByDiscordId = new Map<string, string>();
  for (const value of discordUsersResult.data ?? []) {
    const row = record(value);
    const discordUserId = asString(row?.['discord_user_id']);
    const username = asString(row?.['username']);
    if (discordUserId !== null && username !== null) {
      usernamesByDiscordId.set(discordUserId, username);
    }
  }

  const search = (asString(input.search ?? null) ?? '').trim().toLowerCase();
  const entries: BlacklistEntry[] = [];
  for (const value of blacklistsResult.data ?? []) {
    const row = record(value);
    const id = asString(row?.['id']);
    const reason = asString(row?.['reason']);
    const createdAt = asString(row?.['created_at']);
    if (row === null || id === null || reason === null || createdAt === null) continue;

    const playerId = asString(row['player_id']);
    const player = playerId === null ? null : playersById.get(playerId) ?? null;
    const createdByProfileId = asString(row['created_by']);
    const createdByDiscordId =
      createdByProfileId === null ? null : creatorDiscordIds.get(createdByProfileId) ?? null;
    const creatorUsername =
      createdByDiscordId === null ? null : usernamesByDiscordId.get(createdByDiscordId) ?? null;

    if (search !== '') {
      const haystack = [
        player?.tag ?? '',
        player?.name ?? '',
        reason,
        createdByDiscordId ?? '',
        creatorUsername ?? '',
      ]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(search)) continue;
    }

    entries.push({
      id,
      playerId,
      playerTag: player?.tag ?? null,
      playerName: player?.name ?? null,
      reason,
      createdByProfileId,
      createdByDiscordId,
      createdAt,
      expiresAt: asString(row['expires_at']),
      removedAt: null,
    });
  }

  entries.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return { entries, generatedAt: new Date() };
}
