/**
 * Declarative auto-role setup and reconciliation.
 *
 * All reads and writes are guild-scoped. Role mutations are restricted to the
 * `guild_managed_roles` ledger, and tier decisions use only official-derived
 * player state already stored by the trusted sync/verification paths.
 */

import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client, Guild, GuildMember } from 'discord.js';
import { AdminServiceError, recordAdminAudit } from '../admin/service.js';
import type { AdminActor } from '../admin/types.js';
import { asNumber, asString, record, requireOk } from '../clubs/service.js';
import { readGuildMembershipRoles } from '../club-roles/service.js';
import { selectGuildMainLinks } from '../ranked-roles/service.js';
import { listGuildVerifiedLinks } from '../verification/service.js';
import { planLedgerRoleChanges, type LedgerRoleChanges } from './changes.js';
import {
  candidateRoleNames,
  computeDesiredTierKeys,
  countProfileBrawlers,
  DEFAULT_TIER_KEYS,
  defaultRoleName,
  isRoleKind,
  priorityFor,
  ROLE_KINDS,
  ROLE_KIND_LABELS,
  roleColor,
  type RoleKind,
  type TierSource,
} from './tiers.js';

const logger = createLogger('bot/role-automation');
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const ROLE_REASON = 'BrawlHub auto roles';

const PLAYER_COLUMNS = [
  'id',
  'trophies',
  'exp_level',
  'fame',
  'three_vs_three_victories',
  'solo_victories',
  'duo_victories',
  'ranked_rank_name',
  'profile_extra',
].join(', ');

/** Set by `reconcileAllConfiguredRoles` for the post-verification hook. */
let cachedClient: Client | null = null;

export function setRoleAutomationClient(client: Client): void {
  cachedClient = client;
}

export interface RoleAutomationOptions {
  readonly db?: SupabaseClient;
  readonly client?: Client;
}

export interface AutoRoleConfig {
  readonly guildId: string;
  readonly kind: RoleKind;
  readonly tierKey: string;
  readonly roleId: string;
  readonly enabled: boolean;
  readonly priority: number;
}

export interface AutoRoleSetupSummary {
  readonly guildId: string;
  readonly configuredRoles: number;
  readonly createdRoles: number;
  readonly reusedRoles: number;
  readonly managedRoles: number;
  readonly kinds: readonly string[];
  readonly tiers: Readonly<Record<RoleKind, readonly string[]>>;
  readonly channelId: string | null;
}

export interface ReconcileCounts {
  readonly rolesAdded: number;
  readonly rolesRemoved: number;
  readonly rolesUnchanged: number;
  readonly errorCount: number;
  readonly membersNotFound: number;
}

export interface GuildRoleReconcileResult extends ReconcileCounts {
  readonly guildId: string;
  readonly runId: string | null;
  readonly configuredRoles: number;
  readonly managedRoles: number;
  readonly usersProcessed: number;
}

export interface ReconcileAllRolesResult extends ReconcileCounts {
  readonly guilds: number;
  readonly configuredGuilds: number;
}

export type MemberHookKind =
  | 'ok'
  | 'invalid-user'
  | 'guild-unavailable'
  | 'not-configured'
  | 'not-verified'
  | 'not-member';

export interface MemberHookResult extends ReconcileCounts {
  readonly kind: MemberHookKind;
}

interface MutableCounts {
  rolesAdded: number;
  rolesRemoved: number;
  rolesUnchanged: number;
  errorCount: number;
  membersNotFound: number;
}

interface MainLink {
  readonly discordUserId: string;
  readonly playerId: string;
  readonly isMain: boolean;
}

interface PlayerData {
  readonly id: string;
  readonly source: TierSource;
}

interface ActiveAssignment {
  readonly discordUserId: string;
  readonly discordRoleId: string;
  readonly profileId: string | null;
  readonly playerId: string | null;
  readonly sourceKind: RoleKind;
  readonly sourceId: string | null;
}

interface DesiredRole {
  readonly kind: RoleKind;
  readonly tierKey: string;
  readonly roleId: string;
}

interface DesiredAssignment {
  readonly discordUserId: string;
  readonly profileId: string | null;
  readonly playerId: string;
  readonly roles: ReadonlyMap<string, DesiredRole>;
}

interface ReconcileContext {
  readonly configs: readonly AutoRoleConfig[];
  readonly ledger: ReadonlyMap<string, RoleKind>;
  readonly links: readonly MainLink[];
  readonly profiles: ReadonlyMap<string, string>;
  readonly players: ReadonlyMap<string, PlayerData>;
  readonly membershipRoles: ReadonlyMap<string, string>;
  readonly assignments: ReadonlyMap<string, ReadonlyMap<string, ActiveAssignment>>;
}

function dbFor(options: RoleAutomationOptions): SupabaseClient {
  return options.db ?? createTrustedClient();
}

function requireGuildId(guildId: string): string {
  const trimmed = guildId.trim();
  if (!SNOWFLAKE_PATTERN.test(trimmed)) {
    throw new AdminServiceError('invalid_guild', 'A valid Discord guild is required.');
  }
  return trimmed;
}

function requireRoleId(roleId: string, context: string): string {
  const trimmed = roleId.trim();
  if (!SNOWFLAKE_PATTERN.test(trimmed)) {
    throw new AdminServiceError('invalid_role', `${context} is not a valid Discord role.`);
  }
  return trimmed;
}

function freshCounts(): MutableCounts {
  return { rolesAdded: 0, rolesRemoved: 0, rolesUnchanged: 0, errorCount: 0, membersNotFound: 0 };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function parseStringMap(value: unknown): Record<string, string> {
  const source = record(value);
  if (source === null) return {};
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    const roleId = asString(item);
    if (roleId !== null && SNOWFLAKE_PATTERN.test(roleId)) map[key] = roleId;
  }
  return map;
}

function parseConfigRow(value: unknown): AutoRoleConfig | null {
  const row = record(value);
  if (row === null) return null;
  const guildId = asString(row['guild_id']);
  const kind = row['role_kind'];
  const tierKey = asString(row['tier_key']);
  const roleId = asString(row['discord_role_id']);
  if (
    guildId === null ||
    !isRoleKind(kind) ||
    tierKey === null ||
    tierKey.trim() === '' ||
    roleId === null ||
    !SNOWFLAKE_PATTERN.test(roleId)
  ) {
    return null;
  }
  return {
    guildId,
    kind,
    tierKey,
    roleId,
    enabled: row['enabled'] !== false,
    priority: asNumber(row['priority']) ?? 0,
  };
}

function parseAssignmentRow(value: unknown): ActiveAssignment | null {
  const row = record(value);
  if (row === null) return null;
  const discordUserId = asString(row['discord_user_id']);
  const discordRoleId = asString(row['discord_role_id']);
  const kind = row['source_kind'];
  if (
    discordUserId === null ||
    discordRoleId === null ||
    !isRoleKind(kind)
  ) {
    return null;
  }
  return {
    discordUserId,
    discordRoleId,
    profileId: asString(row['profile_id']),
    playerId: asString(row['player_id']),
    sourceKind: kind,
    sourceId: asString(row['source_id']),
  };
}

function parsePlayerRow(value: unknown): PlayerData | null {
  const row = record(value);
  if (row === null) return null;
  const id = asString(row['id']);
  if (id === null) return null;
  return {
    id,
    source: {
      trophies: asNumber(row['trophies']),
      level: asNumber(row['exp_level']),
      fame: asNumber(row['fame']),
      vsVictories: asNumber(row['three_vs_three_victories']),
      soloVictories: asNumber(row['solo_victories']),
      duoVictories: asNumber(row['duo_victories']),
      rankedRankName: asString(row['ranked_rank_name']),
      brawlerCount: countProfileBrawlers(row['profile_extra']),
    },
  };
}

async function loadConfigs(
  guildId: string,
  db: SupabaseClient,
  enabledOnly: boolean,
): Promise<AutoRoleConfig[]> {
  const query = db
    .from('guild_auto_role_configs')
    .select('guild_id, role_kind, tier_key, discord_role_id, enabled, priority')
    .eq('guild_id', guildId);
  const result = enabledOnly ? await query.eq('enabled', true) : await query;
  requireOk(result.error, 'Read auto role configuration');
  return (result.data ?? [])
    .map(parseConfigRow)
    .filter((config): config is AutoRoleConfig => config !== null)
    .sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind));
}

async function loadLedger(guildId: string, db: SupabaseClient): Promise<Map<string, RoleKind>> {
  const result = await db
    .from('guild_managed_roles')
    .select('guild_id, discord_role_id, role_kind')
    .eq('guild_id', guildId);
  requireOk(result.error, 'Read managed role ledger');
  const ledger = new Map<string, RoleKind>();
  for (const value of result.data ?? []) {
    const row = record(value);
    const roleId = asString(row?.['discord_role_id']);
    const kind = row?.['role_kind'];
    if (roleId !== null && SNOWFLAKE_PATTERN.test(roleId) && isRoleKind(kind)) {
      ledger.set(roleId, kind);
    }
  }
  return ledger;
}

async function loadAssignments(
  guildId: string,
  db: SupabaseClient,
): Promise<Map<string, Map<string, ActiveAssignment>>> {
  const result = await db
    .from('guild_role_assignments')
    .select(
      'guild_id, discord_user_id, discord_role_id, profile_id, player_id, source_kind, source_id',
    )
    .eq('guild_id', guildId)
    .is('revoked_at', null);
  requireOk(result.error, 'Read active role assignments');
  const assignments = new Map<string, Map<string, ActiveAssignment>>();
  for (const value of result.data ?? []) {
    const assignment = parseAssignmentRow(value);
    if (assignment === null) continue;
    const byRole = assignments.get(assignment.discordUserId) ?? new Map<string, ActiveAssignment>();
    byRole.set(assignment.discordRoleId, assignment);
    assignments.set(assignment.discordUserId, byRole);
  }
  return assignments;
}

async function loadMainLinks(guildId: string, db: SupabaseClient): Promise<MainLink[]> {
  const links = await listGuildVerifiedLinks(guildId, { db });
  return selectGuildMainLinks(
    links.map((link) => ({
      discordUserId: link.discordUserId,
      playerId: link.playerId,
      isMain: link.isMain,
    })),
  );
}

async function loadProfiles(
  db: SupabaseClient,
  discordUserIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = unique(discordUserIds);
  const profiles = new Map<string, string>();
  if (ids.length === 0) return profiles;
  const result = await db
    .from('profiles')
    .select('id, discord_user_id')
    .in('discord_user_id', ids);
  requireOk(result.error, 'Read profiles for role assignments');
  for (const value of result.data ?? []) {
    const row = record(value);
    const profileId = asString(row?.['id']);
    const discordUserId = asString(row?.['discord_user_id']);
    if (profileId !== null && discordUserId !== null) profiles.set(discordUserId, profileId);
  }
  return profiles;
}

async function loadPlayers(
  db: SupabaseClient,
  playerIds: readonly string[],
): Promise<Map<string, PlayerData>> {
  const ids = unique(playerIds);
  const players = new Map<string, PlayerData>();
  if (ids.length === 0) return players;
  const result = await db.from('players').select(PLAYER_COLUMNS).in('id', ids);
  requireOk(result.error, 'Read official player fields for auto roles');
  for (const value of result.data ?? []) {
    const player = parsePlayerRow(value);
    if (player !== null) players.set(player.id, player);
  }
  return players;
}

async function loadReconcileContext(
  guildId: string,
  db: SupabaseClient,
): Promise<ReconcileContext> {
  const [configs, ledger, links] = await Promise.all([
    loadConfigs(guildId, db, true),
    loadLedger(guildId, db),
    loadMainLinks(guildId, db),
  ]);
  const [profiles, players, membershipRoles, assignments] = await Promise.all([
    loadProfiles(db, links.map((link) => link.discordUserId)),
    loadPlayers(db, links.map((link) => link.playerId)),
    readGuildMembershipRoles(guildId, links.map((link) => link.playerId), { db }),
    loadAssignments(guildId, db),
  ]);
  const clubRanks = new Map<string, string>();
  for (const [playerId, rank] of membershipRoles) clubRanks.set(playerId, rank);
  return { configs, ledger, links, profiles, players, membershipRoles: clubRanks, assignments };
}

function buildDesiredAssignments(context: ReconcileContext): Map<string, DesiredAssignment> {
  const configsByKind = new Map<RoleKind, AutoRoleConfig[]>();
  for (const config of context.configs) {
    if (context.ledger.get(config.roleId) !== config.kind) continue;
    const list = configsByKind.get(config.kind) ?? [];
    list.push(config);
    configsByKind.set(config.kind, list);
  }

  const desired = new Map<string, DesiredAssignment>();
  for (const link of context.links) {
    const player = context.players.get(link.playerId);
    const clubRank = context.membershipRoles.get(link.playerId);
    const source: TierSource = {
      ...(player?.source ?? {}),
      verified: true,
      clubRoles: clubRank === undefined ? [] : [clubRank],
    };
    const roles = new Map<string, DesiredRole>();
    for (const [kind, configs] of configsByKind) {
      const keys = computeDesiredTierKeys(
        kind,
        source,
        configs.map((config) => config.tierKey),
      );
      for (const tierKey of keys) {
        const config = configs.find((candidate) => candidate.tierKey === tierKey);
        if (config === undefined) continue;
        roles.set(config.roleId, { kind, tierKey, roleId: config.roleId });
      }
    }

    desired.set(link.discordUserId, {
      discordUserId: link.discordUserId,
      profileId: context.profiles.get(link.discordUserId) ?? null,
      playerId: link.playerId,
      roles,
    });
  }
  return desired;
}

async function fetchMember(guild: Guild, discordUserId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(discordUserId);
  } catch {
    return null;
  }
}

async function mutateRolePlan(
  member: GuildMember,
  changes: LedgerRoleChanges,
  counts: MutableCounts,
): Promise<{ readonly added: string[]; readonly removed: string[] }> {
  const added: string[] = [];
  const removed: string[] = [];

  for (const roleId of changes.removeRoleIds) {
    if (!member.roles.cache.has(roleId)) continue;
    try {
      await member.roles.remove(roleId, ROLE_REASON);
      removed.push(roleId);
      counts.rolesRemoved += 1;
    } catch (error) {
      counts.errorCount += 1;
      logger.warn('Could not remove a managed role', { roleId, error: errorMessage(error) });
    }
  }

  for (const roleId of changes.addRoleIds) {
    if (member.roles.cache.has(roleId)) continue;
    try {
      await member.roles.add(roleId, ROLE_REASON);
      added.push(roleId);
      counts.rolesAdded += 1;
    } catch (error) {
      counts.errorCount += 1;
      logger.warn('Could not add a managed role', { roleId, error: errorMessage(error) });
    }
  }

  counts.rolesUnchanged += changes.unchangedRoleIds.length;
  return { added, removed };
}

async function revokeAssignments(
  db: SupabaseClient,
  guildId: string,
  discordUserId: string,
  roleIds: readonly string[],
): Promise<void> {
  const revokedAt = new Date().toISOString();
  for (const roleId of unique(roleIds)) {
    const result = await db
      .from('guild_role_assignments')
      .update({ revoked_at: revokedAt })
      .eq('guild_id', guildId)
      .eq('discord_user_id', discordUserId)
      .eq('discord_role_id', roleId)
      .is('revoked_at', null);
    requireOk(result.error, 'Revoke role assignment');
  }
}

async function writeAssignmentChanges(
  input: {
    readonly db: SupabaseClient;
    readonly guildId: string;
    readonly discordUserId: string;
    readonly desired: DesiredAssignment | undefined;
    readonly active: ReadonlyMap<string, ActiveAssignment> | undefined;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  },
): Promise<void> {
  await revokeAssignments(input.db, input.guildId, input.discordUserId, input.removed);

  const assignedAt = new Date().toISOString();
  for (const roleId of unique(input.added)) {
    if (input.active?.has(roleId) === true) continue;
    const meta = input.desired?.roles.get(roleId);
    if (meta === undefined) continue;
    const result = await input.db.from('guild_role_assignments').insert({
      guild_id: input.guildId,
      discord_user_id: input.discordUserId,
      profile_id: input.desired?.profileId ?? null,
      player_id: input.desired?.playerId ?? null,
      discord_role_id: roleId,
      source_kind: meta.kind,
      source_id: meta.tierKey,
      assigned_at: assignedAt,
    });
    requireOk(result.error, 'Record role assignment');
  }
}

async function applyForMember(input: {
  readonly guildId: string;
  readonly member: GuildMember;
  readonly desired: DesiredAssignment | undefined;
  readonly context: ReconcileContext;
  readonly db: SupabaseClient;
  readonly counts: MutableCounts;
}): Promise<void> {
  const changes = planLedgerRoleChanges({
    desiredRoleIds: input.desired === undefined ? [] : [...input.desired.roles.keys()],
    heldRoleIds: [...input.member.roles.cache.keys()],
    managedRoleIds: [...input.context.ledger.keys()],
  });
  const applied = await mutateRolePlan(input.member, changes, input.counts);
  await writeAssignmentChanges({
    db: input.db,
    guildId: input.guildId,
    discordUserId: input.member.id,
    desired: input.desired,
    active: input.context.assignments.get(input.member.id),
    added: applied.added,
    removed: applied.removed,
  });
}

async function startSyncRun(guildId: string, db: SupabaseClient): Promise<string> {
  const result = await db
    .from('guild_role_sync_runs')
    .insert({ guild_id: guildId, status: 'running', started_at: new Date().toISOString() })
    .select('id')
    .single();
  requireOk(result.error, 'Start role sync run');
  const runId = asString(record(result.data)?.['id']);
  if (runId === null) throw new Error('Role sync run was not created');
  return runId;
}

async function finishSyncRun(input: {
  readonly db: SupabaseClient;
  readonly runId: string;
  readonly guildId: string;
  readonly status: 'completed' | 'failed';
  readonly counts: MutableCounts;
  readonly lastError?: string;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    finished_at: new Date().toISOString(),
    roles_added: input.counts.rolesAdded,
    roles_removed: input.counts.rolesRemoved,
    roles_unchanged: input.counts.rolesUnchanged,
    error_count: input.counts.errorCount,
  };
  if (input.lastError !== undefined) patch['last_error'] = input.lastError;
  const result = await input.db
    .from('guild_role_sync_runs')
    .update(patch)
    .eq('id', input.runId)
    .eq('guild_id', input.guildId);
  requireOk(result.error, 'Finish role sync run');
}

/**
 * Create/reuse and record every default role for a guild. The verification
 * message itself is still owned by `setupGuildAutomation`; this function only
 * writes the declarative configuration and its managed-role ledger.
 */
export async function setupGuildAutoRoles(
  guild: Guild,
  actor: AdminActor,
  channelId?: string,
  options: RoleAutomationOptions = {},
): Promise<AutoRoleSetupSummary> {
  const guildId = requireGuildId(guild.id);
  if (channelId !== undefined) requireRoleId(channelId, 'The verification channel');
  const db = dbFor(options);
  await guild.roles.fetch();

  const settings = await db
    .from('guild_settings')
    .select('verified_role_id, ranked_role_ids, club_role_ids')
    .eq('guild_id', guildId)
    .maybeSingle();
  requireOk(settings.error, 'Read role settings for auto setup');
  const legacy = record(settings.data);
  const verifiedRoleId = asString(legacy?.['verified_role_id']);
  const rankedRoleIds = parseStringMap(legacy?.['ranked_role_ids']);
  const clubRoleIds = parseStringMap(legacy?.['club_role_ids']);

  const configRows: Record<string, unknown>[] = [];
  const ledgerRows: Record<string, unknown>[] = [];
  const managed = new Set<string>();
  let createdRoles = 0;
  let reusedRoles = 0;

  for (const { kind } of ROLE_KINDS) {
    const tierKeys = DEFAULT_TIER_KEYS[kind];
    for (const [tierIndex, tierKey] of tierKeys.entries()) {
      let legacyRoleId: string | null = null;
      if (kind === 'verify') legacyRoleId = verifiedRoleId;
      else if (kind === 'ranked') legacyRoleId = rankedRoleIds[tierKey.toUpperCase()] ?? null;
      else if (kind === 'club') legacyRoleId = clubRoleIds[tierKey] ?? null;

      const resolved = await resolveOrCreateRole(guild, kind, tierKey, legacyRoleId);
      if (resolved.created) createdRoles += 1;
      else reusedRoles += 1;

      configRows.push({
        guild_id: guildId,
        role_kind: kind,
        tier_key: tierKey,
        discord_role_id: resolved.roleId,
        enabled: true,
        priority: priorityFor(kind, tierIndex),
        updated_at: new Date().toISOString(),
      });
      if (!managed.has(resolved.roleId)) {
        managed.add(resolved.roleId);
        ledgerRows.push({
          guild_id: guildId,
          discord_role_id: resolved.roleId,
          role_kind: kind,
          created_by_profile_id: actor.profileId,
        });
      }
    }
  }

  const savedConfigs = await db.from('guild_auto_role_configs').upsert(configRows, {
    onConflict: 'guild_id,role_kind,tier_key',
  });
  requireOk(savedConfigs.error, 'Save auto role configuration');
  const savedLedger = await db.from('guild_managed_roles').upsert(ledgerRows, {
    onConflict: 'guild_id,discord_role_id',
  });
  requireOk(savedLedger.error, 'Save managed role ledger');

  await recordAdminAudit(
    {
      actor,
      action: 'guild.auto_roles.setup',
      targetType: 'guild',
      targetId: guildId,
      guildId,
      details: {
        configuredRoles: configRows.length,
        managedRoles: managed.size,
        createdRoles,
        reusedRoles,
        channelId: channelId ?? null,
        kinds: ROLE_KINDS.map((entry) => entry.kind),
      },
    },
    { db, guildId },
  );

  logger.info('Declarative auto roles set up', {
    guildId,
    configuredRoles: configRows.length,
    managedRoles: managed.size,
  });

  return {
    guildId,
    configuredRoles: configRows.length,
    createdRoles,
    reusedRoles,
    managedRoles: managed.size,
    kinds: ROLE_KINDS.map((entry) => ROLE_KIND_LABELS[entry.kind]),
    tiers: DEFAULT_TIER_KEYS,
    channelId: channelId ?? null,
  };
}

async function resolveOrCreateRole(
  guild: Guild,
  kind: RoleKind,
  tierKey: string,
  legacyRoleId: string | null,
): Promise<{ readonly roleId: string; readonly created: boolean }> {
  const names = candidateRoleNames(kind, tierKey);
  let existing =
    legacyRoleId === null ? null : guild.roles.cache.get(legacyRoleId) ?? null;
  if (existing !== null && existing.managed) existing = null;
  if (existing === null) {
    for (const name of names) {
      const candidate = guild.roles.cache.find((role) => role.name === name && !role.managed);
      if (candidate !== undefined) {
        existing = candidate;
        break;
      }
    }
  }
  if (existing !== null) return { roleId: existing.id, created: false };

  const created = await guild.roles.create({
    name: names[0] ?? defaultRoleName(kind, tierKey),
    color: roleColor(kind, tierKey),
    hoist: false,
    mentionable: true,
    reason: 'BrawlHub /auto setup managed role',
  });
  return { roleId: requireRoleId(created.id, 'The created role'), created: true };
}

/** Full guild reconciliation, with one durable sync-run row per attempt. */
export async function reconcileGuildRoles(
  guild: Guild,
  guildId: string,
  options: RoleAutomationOptions = {},
): Promise<GuildRoleReconcileResult> {
  const parsedGuildId = requireGuildId(guildId);
  if (guild.id !== parsedGuildId) {
    throw new AdminServiceError('guild_mismatch', 'The guild does not match this configuration.');
  }
  const db = dbFor(options);
  const counts = freshCounts();
  let runId: string | null = null;

  try {
    runId = await startSyncRun(parsedGuildId, db);
    const context = await loadReconcileContext(parsedGuildId, db);
    const desiredByUser = buildDesiredAssignments(context);
    const members = await guild.members.fetch().catch(() => null);
    const processed = new Set<string>();

    for (const [discordUserId, desired] of desiredByUser) {
      processed.add(discordUserId);
      const member = members?.get(discordUserId) ?? (await fetchMember(guild, discordUserId));
      if (member === null) {
        counts.membersNotFound += 1;
        continue;
      }
      await applyForMember({
        guildId: parsedGuildId,
        member,
        desired,
        context,
        db,
        counts,
      });
    }

    if (members !== null) {
      for (const member of members.values()) {
        if (processed.has(member.id)) continue;
        const holdsManagedRole = [...member.roles.cache.keys()].some((roleId) =>
          context.ledger.has(roleId),
        );
        if (!holdsManagedRole && !context.assignments.has(member.id)) continue;
        await applyForMember({
          guildId: parsedGuildId,
          member,
          desired: undefined,
          context,
          db,
          counts,
        });
      }
    } else {
      // Members could not be listed; still close active ledger rows we can no
      // longer confirm, without touching any Discord role we cannot see.
      for (const [discordUserId, byRole] of context.assignments) {
        if (processed.has(discordUserId)) continue;
        await revokeAssignments(db, parsedGuildId, discordUserId, [...byRole.keys()]);
      }
    }

    // Users who left the guild (or lost their link) have no member object to
    // mutate; close their ledger rows without guessing at Discord state.
    if (members !== null) {
      for (const [discordUserId, byRole] of context.assignments) {
        if (processed.has(discordUserId) || members.has(discordUserId)) continue;
        await revokeAssignments(db, parsedGuildId, discordUserId, [...byRole.keys()]);
      }
    }

    await finishSyncRun({
      db,
      runId,
      guildId: parsedGuildId,
      status: 'completed',
      counts,
    });
    return {
      guildId: parsedGuildId,
      runId,
      ...counts,
      configuredRoles: context.configs.length,
      managedRoles: context.ledger.size,
      usersProcessed: processed.size,
    };
  } catch (error) {
    if (runId !== null) {
      try {
        await finishSyncRun({
          db,
          runId,
          guildId: parsedGuildId,
          status: 'failed',
          counts,
          lastError: errorMessage(error),
        });
      } catch (finishError) {
        logger.warn('Could not close a failed role sync run', {
          guildId: parsedGuildId,
          error: errorMessage(finishError),
        });
      }
    }
    throw error;
  }
}

/** Reconcile every configured guild. Returns aggregate counts for the caller. */
export async function reconcileAllConfiguredRoles(
  client: Client,
  options: RoleAutomationOptions = {},
): Promise<ReconcileAllRolesResult> {
  setRoleAutomationClient(client);
  const db = dbFor(options);
  const result = await db.from('guild_auto_role_configs').select('guild_id').eq('enabled', true);
  requireOk(result.error, 'Read guilds with auto role configuration');
  const guildIds = unique(
    (result.data ?? [])
      .map((value) => asString(record(value)?.['guild_id']))
      .filter((guildId): guildId is string => guildId !== null)
      .filter((guildId) => SNOWFLAKE_PATTERN.test(guildId)),
  );

  const totals: MutableCounts & { guilds: number; configuredGuilds: number } = {
    ...freshCounts(),
    guilds: 0,
    configuredGuilds: guildIds.length,
  };
  for (const guildId of guildIds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const reconciled = await reconcileGuildRoles(guild, guildId, { db });
      totals.guilds += 1;
      totals.rolesAdded += reconciled.rolesAdded;
      totals.rolesRemoved += reconciled.rolesRemoved;
      totals.rolesUnchanged += reconciled.rolesUnchanged;
      totals.errorCount += reconciled.errorCount;
      totals.membersNotFound += reconciled.membersNotFound;
    } catch (error) {
      totals.errorCount += 1;
      logger.warn('Auto role reconciliation failed for one guild', {
        guildId,
        error: errorMessage(error),
      });
    }
  }
  return totals;
}

/**
 * Lightweight post-verification hook for one Discord user. Pass a Discord
 * client explicitly, or rely on the client cached by `reconcileAllConfiguredRoles`.
 */
export async function reconcileGuildRolesForPlayer(
  guildId: string,
  discordUserId: string,
  options: RoleAutomationOptions = {},
): Promise<MemberHookResult> {
  const parsedGuildId = requireGuildId(guildId);
  const userId = discordUserId.trim();
  if (!SNOWFLAKE_PATTERN.test(userId)) {
    return { kind: 'invalid-user', ...freshCounts() };
  }

  const db = dbFor(options);
  const client = options.client ?? cachedClient;
  if (client === null) return { kind: 'guild-unavailable', ...freshCounts() };
  let guild: Guild;
  try {
    guild = await client.guilds.fetch(parsedGuildId);
  } catch {
    return { kind: 'guild-unavailable', ...freshCounts() };
  }
  if (guild.id !== parsedGuildId) return { kind: 'guild-unavailable', ...freshCounts() };

  const context = await loadReconcileContext(parsedGuildId, db);
  if (context.configs.length === 0 || context.ledger.size === 0) {
    return { kind: 'not-configured', ...freshCounts() };
  }
  if (!context.links.some((link) => link.discordUserId === userId)) {
    return { kind: 'not-verified', ...freshCounts() };
  }
  const desired = buildDesiredAssignments(context).get(userId);
  const member = await fetchMember(guild, userId);
  if (member === null) return { kind: 'not-member', ...freshCounts() };

  const counts = freshCounts();
  await applyForMember({
    guildId: parsedGuildId,
    member,
    desired,
    context,
    db,
    counts,
  });
  return { kind: 'ok', ...counts };
}

/** Human-readable list used by `/auto setup` help text. */
export function describeAutoRoleKinds(): string {
  return ROLE_KINDS.map((entry) => entry.label).join(', ');
}
