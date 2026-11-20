import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import {
  ROLE_PERMISSIONS,
  discordIdSchema,
  hasPermission,
  type Permission,
  type Role,
} from '@brawlhub/shared';
import { type SyncResult } from '@brawlhub/sync';
import { PermissionFlagsBits } from 'discord.js';
import { asNumber, asString, record, requireOk } from '../clubs/service';
import { safeErrorMessage } from '../discord/errors';
import { StaffServiceError, resolveStaffActor } from '../staff/service';
import { ensureBotProfileForDiscordUser, resolveProfileId } from '../verification/service.js';
import type {
  AdminActor,
  AuditLogEntry,
  AuditLogView,
  GuildRoleMappingView,
  GuildSettingsField,
  GuildSettingsUpdate,
  GuildSettingsView,
  SyncLockSummary,
  SyncRunSummary,
  SyncStatusView,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const log = createLogger('bot');

const AUDIT_LOG_LIMIT = 200;
const DETAIL_STRING_LIMIT = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_MESSAGES: Readonly<Record<Permission, string>> = {
  'clubs:read': 'You do not have permission to view BrawlHub club data.',
  'clubs:write': 'You do not have permission to manage BrawlHub configuration.',
  'players:read': 'You do not have permission to view BrawlHub player data.',
  'sync:run': 'You do not have permission to run or inspect synchronisation.',
  'members:verify': 'You do not have permission to verify members.',
  'staff:manage': 'You do not have permission to manage BrawlHub staff.',
  'competitions:manage': 'You do not have permission to manage competitions.',
  'blacklists:manage': 'You do not have permission to manage blacklists.',
  'audit:read': 'You do not have permission to read the BrawlHub audit log.',
  'notifications:send': 'You do not have permission to send notifications.',
};

const AUDIT_DETAIL_KEYS = [
  'reason',
  'removalReason',
  'playerTag',
  'clubTag',
  'clubName',
  'changedFields',
  'status',
  'clubsProcessed',
  'playersUpserted',
  'snapshotsWritten',
  'membershipEvents',
  'primaryClubId',
] as const;

/** Expected administration failures; raw database errors remain hidden. */
export class AdminServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdminServiceError';
    this.code = code;
  }
}

export interface AdminServiceOptions {
  readonly db?: DatabaseClient;
  readonly guildId?: string | null;
}

export interface DiscordPermissionContext {
  readonly guildId?: string | null;
  readonly isGuildOwner?: boolean;
  readonly memberPermissions?: { has: (permission: bigint) => boolean } | null;
  /** Discord role IDs for the member in this guild, used for configured role mappings. */
  readonly memberRoleIds?: readonly string[] | null | undefined;
  readonly discordUsername?: string | null;
}

export interface AdminPermissionOptions extends AdminServiceOptions, DiscordPermissionContext {}

function dbFor(options: AdminServiceOptions): DatabaseClient {
  return options.db ?? createTrustedClient();
}

const DISCORD_MANAGE_GUILD_PERMISSIONS = new Set<Permission>(
  ([
    'clubs:read',
    'clubs:write',
    'players:read',
    'sync:run',
    'members:verify',
    'competitions:manage',
    'blacklists:manage',
    'notifications:send',
  ] as const) satisfies readonly Permission[],
);

const ROLE_RANK: Readonly<Record<Role, number>> = { owner: 4, admin: 3, staff: 2, member: 1 };

function parseBrawlhubRole(value: unknown): Role | null {
  return value === 'owner' || value === 'admin' || value === 'staff' || value === 'member'
    ? value
    : null;
}

interface GuildRoleMappingRow {
  readonly guild_id: string;
  readonly discord_role_id: string;
  readonly brawlhub_role: string;
  readonly updated_at: string | null;
}

async function readGuildRoleMappings(
  guildId: string,
  db: DatabaseClient,
): Promise<GuildRoleMappingRow[]> {
  const result = await db
    .from('guild_role_mappings')
    .select('guild_id, discord_role_id, brawlhub_role, updated_at')
    .eq('guild_id', guildId);
  requireOk(result.error, 'Read guild role mappings');
  return (Array.isArray(result.data) ? result.data : []) as GuildRoleMappingRow[];
}

function resolveMappedRole(
  memberRoleIds: readonly string[] | null | undefined,
  mappings: readonly GuildRoleMappingRow[],
): Role | null {
  if (memberRoleIds === null || memberRoleIds === undefined || memberRoleIds.length === 0) return null;
  const roleIds = new Set(memberRoleIds);
  let best: Role | null = null;
  for (const mapping of mappings) {
    if (!roleIds.has(mapping.discord_role_id)) continue;
    const role = parseBrawlhubRole(mapping.brawlhub_role);
    if (role === null) continue;
    if (best === null || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

function hasDiscordBreakglassGrant(
  permission: Permission,
  context: DiscordPermissionContext,
): boolean {
  if (context.guildId === null || context.guildId === undefined) return false;
  if (context.isGuildOwner === true) return true;
  const perms = context.memberPermissions;
  if (perms == null) return false;
  if (perms.has(PermissionFlagsBits.Administrator)) return true;
  if (perms.has(PermissionFlagsBits.ManageGuild)) {
    return DISCORD_MANAGE_GUILD_PERMISSIONS.has(permission);
  }
  return false;
}

function impliedRoleForDiscordGrant(context: DiscordPermissionContext, mappedRole?: Role | null): Role {
  if (mappedRole !== null && mappedRole !== undefined) return mappedRole;
  if (context.isGuildOwner === true) return 'owner';
  const perms = context.memberPermissions;
  if (perms != null && perms.has(PermissionFlagsBits.Administrator)) return 'owner';
  return 'admin';
}

async function resolveOrProvisionActor(
  discordUserId: string,
  context: AdminPermissionOptions,
  impliedRole: Role,
): Promise<AdminActor> {
  const parsedId = discordIdSchema.safeParse(discordUserId);
  if (!parsedId.success) {
    throw new AdminServiceError('forbidden', 'A valid Discord user is required.');
  }

  const db = context.db;
  try {
    const actor = await resolveStaffActor(parsedId.data, db === undefined ? undefined : { db });
    // Preserve a stronger DB/global role if present; otherwise reflect granted role.
    if (actor.globalRole !== null && ROLE_RANK[actor.globalRole] >= ROLE_RANK[impliedRole]) {
      return actor;
    }
    return { ...actor, globalRole: impliedRole };
  } catch (error) {
    const notLinked =
      error instanceof StaffServiceError && error.code === 'profile_not_linked';
    if (!notLinked) throw error;
  }

  let profileId: string | null = await resolveProfileId(parsedId.data);
  if (profileId === null) {
    try {
      profileId = await ensureBotProfileForDiscordUser(parsedId.data, context.discordUsername ?? null);
    } catch {
      profileId = await resolveProfileId(parsedId.data);
    }
  }
  if (profileId === null) {
    throw new AdminServiceError(
      'profile_unavailable',
      'BrawlHub could not prepare your Discord-linked account for this action. Please sign in to the website and try again.',
    );
  }

  return {
    profileId,
    discordUserId: parsedId.data,
    globalRole: impliedRole,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseTimestamp(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Resolve the Discord user and require a permission in the given guild context.
 * Precedence: Discord break-glass (owner/Administrator/Manage Guild where
 * applicable) > configured per-guild Discord role mappings > DB global role.
 * Club-scoped DB roles are ignored by resolveStaffActor() and do not grant access
 * here.
 */
export async function requireGlobalPermission(
  discordUserId: string,
  permission: Permission,
  options: AdminPermissionOptions = {},
): Promise<AdminActor> {
  if (hasDiscordBreakglassGrant(permission, options)) {
    return resolveOrProvisionActor(discordUserId, options, impliedRoleForDiscordGrant(options));
  }

  if (options.guildId !== null && options.guildId !== undefined) {
    const parsedGuildId = discordIdSchema.safeParse(options.guildId);
    if (parsedGuildId.success) {
      const db = dbFor(options);
      const mappings = await readGuildRoleMappings(parsedGuildId.data, db);
      const mappedRole = resolveMappedRole(options.memberRoleIds, mappings);
      if (mappedRole !== null && hasPermission(mappedRole, permission)) {
        return resolveOrProvisionActor(
          discordUserId,
          { ...options, db },
          impliedRoleForDiscordGrant(options, mappedRole),
        );
      }
    }
  }

  const actor =
    options.db === undefined
      ? await resolveStaffActor(discordUserId)
      : await resolveStaffActor(discordUserId, { db: options.db });

  if (actor.globalRole === null || !hasPermission(actor.globalRole, permission)) {
    throw new AdminServiceError('forbidden', FORBIDDEN_MESSAGES[permission]);
  }
  return actor;
}

interface GuildSettingsRow {
  guild_id: string;
  primary_club_id: string | null;
  announcement_channel_id: string | null;
  verified_role_id: string | null;
  overview_channel_id: string | null;
  overview_message_id: string | null;
  updated_at: string | null;
}

async function readGuildSettingsRow(
  guildId: string,
  db: DatabaseClient,
): Promise<GuildSettingsRow | null> {
  const result = await db
    .from('guild_settings')
    .select(
      'guild_id, primary_club_id, announcement_channel_id, verified_role_id, overview_channel_id, overview_message_id, updated_at',
    )
    .eq('guild_id', guildId)
    .maybeSingle();
  requireOk(result.error, 'Read guild settings');
  return (result.data ?? null) as GuildSettingsRow | null;
}

export async function loadGuildSettings(
  guildId: string,
  options: AdminServiceOptions = {},
): Promise<GuildSettingsView> {
  const parsedGuildId = discordIdSchema.safeParse(guildId);
  if (!parsedGuildId.success) {
    throw new AdminServiceError('invalid_guild', 'A valid configured Discord guild is required.');
  }
  const db = dbFor(options);
  const row = await readGuildSettingsRow(parsedGuildId.data, db);

  let primaryClubTag: string | null = null;
  let primaryClubName: string | null = null;
  if (row?.primary_club_id !== null && row?.primary_club_id !== undefined) {
    const club = await db
      .from('clubs')
      .select('tag, name')
      .eq('id', row.primary_club_id)
      .eq('guild_id', parsedGuildId.data)
      .is('archived_at', null)
      .maybeSingle();
    requireOk(club.error, 'Read primary club');
    const clubRow = record(club.data);
    primaryClubTag = asString(clubRow?.['tag']);
    primaryClubName = asString(clubRow?.['name']);
  }

  return {
    guildId: parsedGuildId.data,
    primaryClubId: asString(row?.['primary_club_id']),
    primaryClubTag,
    primaryClubName,
    announcementChannelId: asString(row?.['announcement_channel_id']),
    verifiedRoleId: asString(row?.['verified_role_id']),
    overviewChannelId: asString(row?.['overview_channel_id']),
    overviewMessageId: asString(row?.['overview_message_id']),
    updatedAt: asString(row?.['updated_at']),
  };
}

async function validateSettingValue(
  field: GuildSettingsField,
  value: string | null,
  guildId: string,
  db: DatabaseClient,
): Promise<string | null> {
  if (value === null) return null;

  if (field === 'primaryClubId') {
    const normalized = value.trim();
    if (!UUID_PATTERN.test(normalized)) {
      throw new AdminServiceError('invalid_club', 'Select a registered club from the autocomplete list.');
    }
    const club = await db
      .from('clubs')
      .select('id')
      .eq('id', normalized)
      .eq('guild_id', guildId)
      .is('archived_at', null)
      .maybeSingle();
    requireOk(club.error, 'Validate primary club');
    if (club.data === null) {
      throw new AdminServiceError('invalid_club', 'That club is not registered with BrawlHub in this server.');
    }
    return normalized;
  }

  const parsed = discordIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminServiceError(
      field === 'verifiedRoleId' ? 'invalid_role' : 'invalid_channel',
      'Select a valid Discord snowflake.',
    );
  }
  return parsed.data;
}

export async function updateGuildSettings(
  input: GuildSettingsUpdate,
  options: AdminServiceOptions = {},
): Promise<GuildSettingsView> {
  const parsedGuildId = discordIdSchema.safeParse(input.guildId);
  if (!parsedGuildId.success) {
    throw new AdminServiceError('invalid_guild', 'A valid configured Discord guild is required.');
  }

  const db = dbFor(options);
  const existing = await readGuildSettingsRow(parsedGuildId.data, db);
  const value = await validateSettingValue(input.field, input.value, parsedGuildId.data, db);

  const next: GuildSettingsRow = {
    guild_id: parsedGuildId.data,
    primary_club_id: asString(existing?.['primary_club_id']),
    announcement_channel_id: asString(existing?.['announcement_channel_id']),
    verified_role_id: asString(existing?.['verified_role_id']),
    overview_channel_id: asString(existing?.['overview_channel_id']),
    overview_message_id: asString(existing?.['overview_message_id']),
    updated_at: asString(existing?.['updated_at']),
  };
  if (input.field === 'primaryClubId') next.primary_club_id = value;
  if (input.field === 'announcementChannelId') next.announcement_channel_id = value;
  if (input.field === 'verifiedRoleId') next.verified_role_id = value;
  if (input.field === 'overviewChannelId') {
    next.overview_channel_id = value;
    // A new channel means any previous message is stale; let the poster create a fresh one.
    if (value !== existing?.['overview_channel_id']) next.overview_message_id = null;
  }

  const saved = await db.from('guild_settings').upsert(
    {
      guild_id: next.guild_id,
      primary_club_id: next.primary_club_id,
      announcement_channel_id: next.announcement_channel_id,
      verified_role_id: next.verified_role_id,
      overview_channel_id: next.overview_channel_id,
      overview_message_id: next.overview_message_id,
    },
    { onConflict: 'guild_id' },
  );
  requireOk(saved.error, 'Save guild settings');

  const changedFields: string[] = [];
  if ((existing?.['primary_club_id'] ?? null) !== next.primary_club_id) {
    changedFields.push('primaryClubId');
  }
  if ((existing?.['announcement_channel_id'] ?? null) !== next.announcement_channel_id) {
    changedFields.push('announcementChannelId');
  }
  if ((existing?.['verified_role_id'] ?? null) !== next.verified_role_id) {
    changedFields.push('verifiedRoleId');
  }
  if ((existing?.['overview_channel_id'] ?? null) !== next.overview_channel_id) {
    changedFields.push('overviewChannelId');
  }

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'guild.settings.updated',
      targetType: 'guild',
      targetId: parsedGuildId.data,
      guildId: parsedGuildId.data,
      details: { changedFields, primaryClubId: next.primary_club_id },
    },
    { db },
  );

  return loadGuildSettings(parsedGuildId.data, { db });
}

/**
 * Persist the Discord message ID for a guild's auto-updating overview.
 * Internal bookkeeping only: no audit entry and no user-facing permission check.
 */
export async function setGuildOverviewMessageId(
  guildId: string,
  messageId: string | null,
  options: AdminServiceOptions = {},
): Promise<void> {
  const parsedGuildId = discordIdSchema.safeParse(guildId);
  if (!parsedGuildId.success) return;

  const db = dbFor(options);
  const updated = await db
    .from('guild_settings')
    .update({ overview_message_id: messageId })
    .eq('guild_id', parsedGuildId.data)
    .select('guild_id');
  requireOk(updated.error, 'Save overview message ID');
  if (updated.data !== null && updated.data.length > 0) return;

  const inserted = await db
    .from('guild_settings')
    .insert({ guild_id: parsedGuildId.data, overview_message_id: messageId });
  requireOk(inserted.error, 'Create overview message state');
}

export async function listGuildRoleMappings(
  guildId: string,
  options: AdminServiceOptions = {},
): Promise<GuildRoleMappingView[]> {
  const parsedGuildId = discordIdSchema.safeParse(guildId);
  if (!parsedGuildId.success) {
    throw new AdminServiceError('invalid_guild', 'A valid configured Discord guild is required.');
  }
  const db = dbFor(options);
  const rows = await readGuildRoleMappings(parsedGuildId.data, db);
  return rows
    .map((row) => {
      const role = parseBrawlhubRole(row.brawlhub_role);
      if (role === null) return null;
      return {
        guildId: parsedGuildId.data,
        discordRoleId: row.discord_role_id,
        brawlhubRole: role,
        updatedAt: asString(row.updated_at),
      } satisfies GuildRoleMappingView;
    })
    .filter((row): row is GuildRoleMappingView => row !== null)
    .sort((a, b) => ROLE_RANK[b.brawlhubRole] - ROLE_RANK[a.brawlhubRole] || a.discordRoleId.localeCompare(b.discordRoleId));
}

export async function setGuildRoleMapping(
  input: { actor: AdminActor; guildId: string; discordRoleId: string; brawlhubRole: Role },
  options: AdminServiceOptions = {},
): Promise<GuildRoleMappingView[]> {
  const parsedGuildId = discordIdSchema.safeParse(input.guildId);
  const parsedRoleId = discordIdSchema.safeParse(input.discordRoleId);
  const role = parseBrawlhubRole(input.brawlhubRole);
  if (!parsedGuildId.success) {
    throw new AdminServiceError('invalid_guild', 'A valid configured Discord guild is required.');
  }
  if (!parsedRoleId.success) {
    throw new AdminServiceError('invalid_role', 'Select a valid Discord role.');
  }
  if (role === null) {
    throw new AdminServiceError('invalid_role_mapping', 'Select a valid BrawlHub role.');
  }

  const db = dbFor(options);
  const saved = await db.from('guild_role_mappings').upsert(
    {
      guild_id: parsedGuildId.data,
      discord_role_id: parsedRoleId.data,
      brawlhub_role: role,
    },
    { onConflict: 'guild_id,discord_role_id' },
  );
  requireOk(saved.error, 'Save guild role mapping');

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'guild.role_mapping.updated',
      targetType: 'guild_role_mapping',
      targetId: `${parsedGuildId.data}:${parsedRoleId.data}`,
      guildId: parsedGuildId.data,
      details: { guildId: parsedGuildId.data, discordRoleId: parsedRoleId.data, brawlhubRole: role },
    },
    { db },
  );

  return listGuildRoleMappings(parsedGuildId.data, { db });
}

export async function clearGuildRoleMapping(
  input: { actor: AdminActor; guildId: string; discordRoleId: string },
  options: AdminServiceOptions = {},
): Promise<GuildRoleMappingView[]> {
  const parsedGuildId = discordIdSchema.safeParse(input.guildId);
  const parsedRoleId = discordIdSchema.safeParse(input.discordRoleId);
  if (!parsedGuildId.success) {
    throw new AdminServiceError('invalid_guild', 'A valid configured Discord guild is required.');
  }
  if (!parsedRoleId.success) {
    throw new AdminServiceError('invalid_role', 'Select a valid Discord role.');
  }

  const db = dbFor(options);
  const removed = await db
    .from('guild_role_mappings')
    .delete()
    .eq('guild_id', parsedGuildId.data)
    .eq('discord_role_id', parsedRoleId.data);
  requireOk(removed.error, 'Remove guild role mapping');

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'guild.role_mapping.removed',
      targetType: 'guild_role_mapping',
      targetId: `${parsedGuildId.data}:${parsedRoleId.data}`,
      guildId: parsedGuildId.data,
      details: { guildId: parsedGuildId.data, discordRoleId: parsedRoleId.data },
    },
    { db },
  );

  return listGuildRoleMappings(parsedGuildId.data, { db });
}

interface AdminAuditInput {
  readonly actor: AdminActor;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly details: Record<string, unknown>;
  readonly guildId?: string | null;
}

export async function recordAdminAudit(
  input: AdminAuditInput,
  options: AdminServiceOptions = {},
): Promise<void> {
  const db = dbFor(options);
  const guildId =
    typeof input.guildId === 'string' && input.guildId.trim().length > 0
      ? input.guildId.trim()
      : typeof options.guildId === 'string' && options.guildId.trim().length > 0
        ? options.guildId.trim()
        : null;
  const audit = await db.from('audit_logs').insert({
    actor_profile_id: input.actor.profileId,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    guild_id: guildId,
    details: { ...input.details, actorDiscordId: input.actor.discordUserId },
  });
  if (audit.error !== null && audit.error !== undefined) {
    throw new AdminServiceError('audit_failed', 'The action completed, but audit logging failed.');
  }
}

const SYNC_RUN_COLUMNS = [
  'id',
  'status',
  'period_start',
  'started_at',
  'finished_at',
  'error',
  'last_error',
  'records_processed',
  'affected_club_ids',
  'club_tags',
].join(', ');

function parseSyncRun(value: unknown): SyncRunSummary | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  const status = asString(row['status']);
  if (id === null || status === null) return null;

  return {
    id,
    status,
    periodStart: asString(row['period_start']),
    startedAt: asString(row['started_at']),
    finishedAt: asString(row['finished_at']),
    error: asString(row['error']),
    lastError: asString(row['last_error']),
    recordsProcessed: asNumber(row['records_processed']) ?? 0,
    affectedClubIds: asStringArray(row['affected_club_ids']),
    clubTags: asStringArray(row['club_tags']),
  };
}

export async function loadSyncRun(
  runId: string,
  options: AdminServiceOptions = {},
): Promise<SyncRunSummary | null> {
  const db = dbFor(options);
  const result = await db
    .from('sync_runs')
    .select(SYNC_RUN_COLUMNS)
    .eq('id', runId)
    .maybeSingle();
  requireOk(result.error, 'Read sync run');
  return parseSyncRun(result.data);
}

export async function loadSyncStatus(
  guildId?: string | null,
  options: AdminServiceOptions = {},
): Promise<SyncStatusView> {
  const db = dbFor(options);
  let runQuery = db
    .from('sync_runs')
    .select(SYNC_RUN_COLUMNS)
    .order('period_start', { ascending: false })
    .limit(1);
  const scope = guildId && guildId.trim().length > 0 ? `guild:${guildId.trim()}` : null;
  if (scope !== null) {
    runQuery = runQuery.eq('scope', scope);
  }
  const runResult = await runQuery.maybeSingle();
  requireOk(runResult.error, 'Read latest sync run');

  let lockQuery = db
    .from('sync_locks')
    .select('scope, locked_by, locked_at, locked_until')
    .order('locked_at', { ascending: false, nullsFirst: false })
    .limit(20);
  if (scope !== null) {
    lockQuery = lockQuery.eq('scope', scope);
  }
  const lockResult = await lockQuery;
  requireOk(lockResult.error, 'Read sync locks');
  const lockRows: Array<Record<string, unknown>> = Array.isArray(lockResult.data)
    ? (lockResult.data as Array<Record<string, unknown>>)
    : lockResult.data === null || lockResult.data === undefined
      ? []
      : [lockResult.data as Record<string, unknown>];
  const nowMs = Date.now();
  const activeLockRow =
    lockRows.find((row) => {
      const lockedBy = asString(row['locked_by']);
      const lockedUntilMs = parseTimestamp(asString(row['locked_until']));
      return lockedBy !== null && (lockedUntilMs === null || lockedUntilMs > nowMs);
    }) ?? lockRows[0] ?? null;

  const lockedBy = asString(activeLockRow?.['locked_by']);
  const lockedAt = asString(activeLockRow?.['locked_at']);
  const lockedUntil = asString(activeLockRow?.['locked_until']);
  const lockedUntilMs = parseTimestamp(lockedUntil);
  const active = lockedBy !== null && (lockedUntilMs === null || lockedUntilMs > nowMs);

  const lock: SyncLockSummary = {
    scope: asString(activeLockRow?.['scope']) ?? (scope ?? 'all'),
    lockedBy,
    lockedAt,
    lockedUntil,
    active,
  };

  return {
    latestRun: parseSyncRun(runResult.data),
    lock,
    generatedAt: new Date(),
  };
}

export async function recordSyncRunAudit(
  actor: AdminActor,
  result: SyncResult,
  options: AdminServiceOptions = {},
): Promise<void> {
  try {
    await recordAdminAudit(
      {
        actor,
        action: 'sync.manual.run',
        targetType: 'sync_run',
        targetId: result.syncRunId === '' ? null : result.syncRunId,
        guildId: options.guildId ?? null,
        details: {
          status: result.status,
          clubsProcessed: result.clubsProcessed,
          playersUpserted: result.playersUpserted,
          snapshotsWritten: result.snapshotsWritten,
          membershipEvents: result.membershipEvents,
        },
      },
      options,
    );
  } catch (error) {
    // Match the web admin route: a failed audit write must not turn a completed
    // sync into a reported failure.
    log.error('Manual sync audit logging failed', { error: safeErrorMessage(error) });
  }
}

function safeDetailValue(value: unknown): string | number | string[] | null {
  if (typeof value === 'string') return value.slice(0, DETAIL_STRING_LIMIT);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 20)
      .map((item) => item.slice(0, DETAIL_STRING_LIMIT));
  }
  return null;
}

/** Only a small allowlist of non-sensitive audit fields is shown in Discord. */
export function sanitizeAuditDetails(value: unknown): Record<string, unknown> | null {
  const details = record(value);
  if (details === null) return null;

  const safe: Record<string, unknown> = {};
  for (const key of AUDIT_DETAIL_KEYS) {
    const sanitized = safeDetailValue(details[key]);
    if (sanitized !== null) safe[key] = sanitized;
  }
  return Object.keys(safe).length === 0 ? null : safe;
}

function actorLabel(profile: unknown, profileId: string): string {
  const row = record(profile);
  const discordId = asString(row?.['discord_user_id']);
  const username = asString(row?.['username']);
  if (discordId !== null) return `<@${discordId}>`;
  if (username !== null) return username;
  return `Unknown (${profileId.slice(0, 8)})`;
}

export async function listAuditLogs(
  limit: number,
  options: AdminServiceOptions = {},
): Promise<AuditLogView> {
  const db = dbFor(options);
  const boundedLimit = Math.min(AUDIT_LOG_LIMIT, Math.max(1, Math.floor(limit)));
  let query = db
    .from('audit_logs')
    .select('id, actor_profile_id, action, target_type, target_id, details, created_at')
    .order('created_at', { ascending: false })
    .limit(boundedLimit);
  const guildId =
    typeof options.guildId === 'string' && options.guildId.trim().length > 0
      ? options.guildId.trim()
      : null;
  if (guildId !== null) {
    query = query.eq('guild_id', guildId);
  }
  const result = await query;

  requireOk(result.error, 'Read audit log');
  const rows = Array.isArray(result.data) ? result.data : [];

  const actorIds = [
    ...new Set(
      rows
        .map((value) => asString(record(value)?.['actor_profile_id']))
        .filter((id): id is string => id !== null),
    ),
  ];
  const labels = new Map<string, string>();
  if (actorIds.length > 0) {
    const profiles = await db
      .from('profiles')
      .select('id, discord_user_id, username')
      .in('id', actorIds);
    requireOk(profiles.error, 'Read audit actors');
    for (const profile of profiles.data ?? []) {
      const row = record(profile);
      const id = asString(row?.['id']);
      if (id !== null) labels.set(id, actorLabel(profile, id));
    }
  }

  const entries: AuditLogEntry[] = rows.map((value) => {
    const row = record(value);
    const profileId = asString(row?.['actor_profile_id']);
    return {
      id: asString(row?.['id']) ?? '',
      actorProfileId: profileId,
      actorLabel: profileId === null ? 'System' : (labels.get(profileId) ?? `Unknown (${profileId.slice(0, 8)})`),
      action: asString(row?.['action']) ?? 'unknown',
      targetType: asString(row?.['target_type']),
      targetId: asString(row?.['target_id']),
      details: sanitizeAuditDetails(row?.['details']),
      createdAt: asString(row?.['created_at']),
    };
  });

  return { entries, generatedAt: new Date() };
}
