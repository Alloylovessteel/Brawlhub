import { clubMemberRoleSchema, type ClubMemberRole } from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client, Guild } from 'discord.js';
import { recordAdminAudit, AdminServiceError } from '../admin/service.js';
import type { AdminActor } from '../admin/types.js';
import { asString, record, requireOk } from '../clubs/service.js';
import { listGuildVerifiedLinks } from '../verification/service.js';

const logger = createLogger('bot/club-roles');
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Only these three Brawl Stars roster ranks receive automatic Discord roles. */
export const CLUB_ROLE_RANKS = ['president', 'vicePresident', 'senior'] as const;
export type ClubRoleRank = (typeof CLUB_ROLE_RANKS)[number];
export type ClubRoleMapping = Partial<Record<ClubRoleRank, string>>;

const RANK_LABELS: Readonly<Record<ClubRoleRank, string>> = {
  president: 'President',
  vicePresident: 'Vice President',
  senior: 'Senior',
};

const RANK_COLORS: Readonly<Record<ClubRoleRank, number>> = {
  president: 0xffd700,
  vicePresident: 0x9c27b0,
  senior: 0x3f51b5,
};

/** Highest rank wins when a user has several verified accounts or club memberships. */
const RANK_PRECEDENCE: Readonly<Record<ClubRoleRank, number>> = {
  senior: 1,
  vicePresident: 2,
  president: 3,
};

export interface ClubRoleServiceOptions {
  readonly db?: SupabaseClient;
}

export interface GuildClubRoleState {
  readonly guildId: string;
  readonly mapping: ClubRoleMapping;
}

export interface ClubRoleLink {
  readonly discordUserId: string;
  readonly playerId: string;
  readonly isMain: boolean;
}

export interface ClubRolePlan {
  readonly discordUserId: string;
  readonly rank: ClubRoleRank | null;
  readonly addRoleIds: readonly string[];
  readonly removeRoleIds: readonly string[];
}

export interface ApplyClubRolesResult {
  readonly processed: number;
  readonly membersNotFound: number;
}

export interface ClubRoleRefreshResult extends ApplyClubRolesResult {
  readonly configured: boolean;
  readonly planned: number;
  readonly cleanedMembers: number;
}

export interface RefreshAllClubRolesResult extends ApplyClubRolesResult {
  readonly guilds: number;
  readonly planned: number;
  readonly cleanedMembers: number;
  readonly errors: number;
}

function dbFor(options: ClubRoleServiceOptions): SupabaseClient {
  return options.db ?? createTrustedClient();
}

function requireGuildId(guildId: string): string {
  const trimmed = guildId.trim();
  if (!SNOWFLAKE_PATTERN.test(trimmed)) {
    throw new AdminServiceError('invalid_guild', 'A valid Discord guild is required.');
  }
  return trimmed;
}

function roleName(rank: ClubRoleRank): string {
  return `Club ${RANK_LABELS[rank]}`;
}

export function clubRoleLabel(rank: ClubRoleRank): string {
  return RANK_LABELS[rank];
}

/** Translate an official roster role into a managed Discord role rank. */
export function clubRoleRankFromRole(role: unknown): ClubRoleRank | null {
  const parsed = clubMemberRoleSchema.safeParse(role);
  if (!parsed.success) return null;
  return CLUB_ROLE_RANKS.find((rank) => rank === parsed.data) ?? null;
}

export function resolveClubRoleId(
  mapping: ClubRoleMapping,
  role: unknown,
): string | null {
  const rank = clubRoleRankFromRole(role);
  return rank === null ? null : (mapping[rank] ?? null);
}

/** Return the highest of several official club ranks; unknown ranks are ignored. */
export function chooseHighestClubRole(roles: readonly unknown[]): ClubRoleRank | null {
  let best: ClubRoleRank | null = null;
  for (const role of roles) {
    const rank = clubRoleRankFromRole(role);
    if (rank === null) continue;
    if (best === null || RANK_PRECEDENCE[rank] > RANK_PRECEDENCE[best]) best = rank;
  }
  return best;
}

function parseMapping(value: unknown): ClubRoleMapping {
  const source = record(value);
  if (source === null) return {};
  const mapping: ClubRoleMapping = {};
  for (const rank of CLUB_ROLE_RANKS) {
    const roleId = asString(source[rank]);
    if (roleId !== null && SNOWFLAKE_PATTERN.test(roleId)) mapping[rank] = roleId;
  }
  return mapping;
}

function managedRoleIds(mapping: ClubRoleMapping): string[] {
  return CLUB_ROLE_RANKS.map((rank) => mapping[rank]).filter(
    (roleId): roleId is string => roleId !== undefined,
  );
}

/** Read one guild's club-rank role mapping using the trusted database client. */
export async function loadGuildClubRoleState(
  guildId: string,
  options: ClubRoleServiceOptions = {},
): Promise<GuildClubRoleState> {
  const parsedGuildId = requireGuildId(guildId);
  const result = await dbFor(options)
    .from('guild_settings')
    .select('guild_id, club_role_ids')
    .eq('guild_id', parsedGuildId)
    .maybeSingle();
  requireOk(result.error, 'Read club role settings');
  const row = record(result.data);
  return {
    guildId: parsedGuildId,
    mapping: parseMapping(row?.['club_role_ids']),
  };
}

/** Persist a guild's club-rank role IDs and write an auditable admin event. */
export async function saveGuildClubRoleMapping(
  input: {
    readonly guildId: string;
    readonly mapping: ClubRoleMapping;
    readonly actor: AdminActor;
    readonly action?: string;
  },
  options: ClubRoleServiceOptions = {},
): Promise<GuildClubRoleState> {
  const parsedGuildId = requireGuildId(input.guildId);
  const db = dbFor(options);
  const mapping: ClubRoleMapping = {};
  for (const rank of CLUB_ROLE_RANKS) {
    const roleId = input.mapping[rank];
    if (roleId !== undefined && SNOWFLAKE_PATTERN.test(roleId)) mapping[rank] = roleId;
  }

  const saved = await db.from('guild_settings').upsert(
    {
      guild_id: parsedGuildId,
      club_role_ids: mapping,
    },
    { onConflict: 'guild_id' },
  );
  requireOk(saved.error, 'Save club role settings');

  await recordAdminAudit(
    {
      actor: input.actor,
      action: input.action ?? 'guild.club_roles.updated',
      targetType: 'guild',
      targetId: parsedGuildId,
      guildId: parsedGuildId,
      details: { clubRoleIds: mapping },
    },
    { db, guildId: parsedGuildId },
  );

  return loadGuildClubRoleState(parsedGuildId, { db });
}

/** Reuse configured roles when possible, otherwise create them in this guild. */
export async function ensureClubRoles(
  guild: Guild,
  mapping: ClubRoleMapping,
): Promise<ClubRoleMapping> {
  await guild.roles.fetch();
  const next: ClubRoleMapping = { ...mapping };

  for (const rank of CLUB_ROLE_RANKS) {
    const configured = next[rank];
    const existing =
      configured !== undefined
        ? guild.roles.cache.get(configured) ?? null
        : guild.roles.cache.find((role) => role.name === roleName(rank) && !role.managed) ?? null;
    if (existing !== null && !existing.managed) {
      next[rank] = existing.id;
      continue;
    }

    const created = await guild.roles.create({
      name: roleName(rank),
      color: RANK_COLORS[rank],
      hoist: false,
      mentionable: true,
      reason: 'BrawlHub club role setup',
    });
    next[rank] = created.id;
  }

  return next;
}

const ROLE_PAGE_SIZE = 500;
const ROLE_PLAYER_CHUNK = 500;

export interface GuildMembershipRolesRead {
  readonly roles: Map<string, ClubRoleRank>;
  /** False when the RPC could not provide a complete, stable keyset read. */
  readonly complete: boolean;
}

/**
 * Read current club ranks for verified players in clubs registered to one guild.
 * Guild scope, open memberships and stable keyset paging are enforced in SQL.
 * A malformed or repeated page marks the read incomplete so callers must not
 * use it as evidence that every eligible member has been seen.
 */
export async function readGuildMembershipRolesRead(
  guildId: string,
  playerIds: readonly string[],
  options: ClubRoleServiceOptions = {},
): Promise<GuildMembershipRolesRead> {
  const parsedGuildId = requireGuildId(guildId);
  const uniquePlayerIds = [...new Set(playerIds)].filter((id) => id.trim() !== '');
  const roles = new Map<string, ClubRoleRank>();
  if (uniquePlayerIds.length === 0) return { roles, complete: true };

  const db = dbFor(options);
  let complete = true;
  const seenMemberships = new Set<string>();

  for (let offset = 0; offset < uniquePlayerIds.length; offset += ROLE_PLAYER_CHUNK) {
    const chunk = uniquePlayerIds.slice(offset, offset + ROLE_PLAYER_CHUNK);
    let afterId: string | null = null;

    for (;;) {
      const { data, error } = await db.rpc('guild_club_member_roles', {
        p_guild_id: parsedGuildId,
        p_player_ids: chunk,
        p_limit: ROLE_PAGE_SIZE,
        p_after_id: afterId,
      });
      requireOk(error, 'Read club memberships for club roles');
      const page = Array.isArray(data) ? data : [];
      if (page.length > ROLE_PAGE_SIZE) complete = false;

      let lastId: string | null = null;
      for (const value of page) {
        const row = record(value);
        const membershipId = asString(row?.['membership_id']);
        const playerId = asString(row?.['player_id']);
        const parsedRole = clubMemberRoleSchema.safeParse(row?.['role']);
        if (membershipId === null || playerId === null || !parsedRole.success) {
          complete = false;
          continue;
        }
        if (seenMemberships.has(membershipId)) complete = false;
        seenMemberships.add(membershipId);
        // Every schema-valid membership advances the keyset, including ranks
        // that do not map to a managed Discord role (member, rookie, notMember).
        lastId = membershipId;
        const rank = clubRoleRankFromRole(parsedRole.data);
        if (rank === null) continue;
        const current = roles.get(playerId);
        if (current === undefined || RANK_PRECEDENCE[rank] > RANK_PRECEDENCE[current]) {
          roles.set(playerId, rank);
        }
      }

      if (page.length < ROLE_PAGE_SIZE) break;
      if (lastId === null || lastId === afterId) {
        complete = false;
        break;
      }
      afterId = lastId;
    }
  }

  return { roles, complete };
}

/** Read current club ranks for verified players in clubs registered to one guild. */
export async function readGuildMembershipRoles(
  guildId: string,
  playerIds: readonly string[],
  options: ClubRoleServiceOptions = {},
): Promise<Map<string, ClubRoleRank>> {
  const result = await readGuildMembershipRolesRead(guildId, playerIds, options);
  return result.roles;
}

/** Choose one verified main account per Discord user, deterministically. */
export function selectGuildMainClubLinks(links: readonly ClubRoleLink[]): ClubRoleLink[] {
  const byUser = new Map<string, ClubRoleLink>();
  for (const link of [...links].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
    if (!link.isMain) continue;
    const existing = byUser.get(link.discordUserId);
    if (existing === undefined || link.playerId < existing.playerId) {
      byUser.set(link.discordUserId, link);
    }
  }
  return [...byUser.entries()].map(([discordUserId, link]) => ({ ...link, discordUserId }));
}

/** Plan one Discord role per verified main account from stored official club ranks. */
export function buildClubRolePlans(
  links: readonly ClubRoleLink[],
  membershipRoles: ReadonlyMap<string, ClubRoleRank>,
  mapping: ClubRoleMapping,
): ClubRolePlan[] {
  const allRoleIds = managedRoleIds(mapping);
  const mainLinks = selectGuildMainClubLinks(links);
  const mainsByUser = new Map<string, ClubRoleLink[]>();
  for (const link of mainLinks) {
    const existing = mainsByUser.get(link.discordUserId);
    if (existing === undefined) mainsByUser.set(link.discordUserId, [link]);
    else existing.push(link);
  }

  return mainLinks.map((link) => {
    const ranks = (mainsByUser.get(link.discordUserId) ?? [])
      .map((candidate) => membershipRoles.get(candidate.playerId))
      .filter((rank): rank is ClubRoleRank => rank !== undefined);
    const rank = chooseHighestClubRole(ranks);
    const targetRoleId = rank === null ? null : (mapping[rank] ?? null);
    return {
      discordUserId: link.discordUserId,
      rank,
      addRoleIds: targetRoleId === null ? [] : [targetRoleId],
      removeRoleIds: allRoleIds.filter((roleId) => roleId !== targetRoleId),
    };
  });
}

async function tryClubRoleMutation(
  guildId: string,
  discordUserId: string,
  action: 'add' | 'remove',
  roleId: string,
  mutate: () => Promise<void>,
): Promise<void> {
  try {
    await mutate();
  } catch (error) {
    logger.warn('Could not change a club role', {
      guildId,
      discordUserId,
      action,
      roleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Apply role plans in the invoking guild. Missing members are skipped. */
export async function applyClubRolePlans(
  guild: Guild,
  plans: readonly ClubRolePlan[],
): Promise<ApplyClubRolesResult> {
  let processed = 0;
  let membersNotFound = 0;

  for (const plan of plans) {
    let member;
    try {
      member = await guild.members.fetch(plan.discordUserId);
    } catch {
      membersNotFound += 1;
      continue;
    }

    for (const roleId of plan.removeRoleIds) {
      if (!member.roles.cache.has(roleId)) continue;
      await tryClubRoleMutation(guild.id, plan.discordUserId, 'remove', roleId, async () => {
        await member.roles.remove(roleId, 'BrawlHub club role refresh');
      });
    }
    for (const roleId of plan.addRoleIds) {
      if (member.roles.cache.has(roleId)) continue;
      await tryClubRoleMutation(guild.id, plan.discordUserId, 'add', roleId, async () => {
        await member.roles.add(roleId, 'BrawlHub club role refresh');
      });
    }
    processed += 1;
  }

  return { processed, membersNotFound };
}

/** Which bot-managed roles a member still holds. */
export function selectStaleClubRoleIds(
  memberRoleIds: readonly string[],
  managedIds: readonly string[],
): string[] {
  const held = new Set(memberRoleIds);
  return [...new Set(managedIds)].filter((roleId) => held.has(roleId));
}

async function removeStaleManagedRoles(
  guild: Guild,
  managedIds: readonly string[],
  keepUserIds: ReadonlySet<string>,
): Promise<number> {
  if (managedIds.length === 0) return 0;
  const members = await guild.members.fetch();
  let cleaned = 0;
  for (const member of members.values()) {
    if (keepUserIds.has(member.id)) continue;
    const staleRoleIds = selectStaleClubRoleIds([...member.roles.cache.keys()], managedIds);
    if (staleRoleIds.length === 0) continue;
    for (const roleId of staleRoleIds) {
      await tryClubRoleMutation(guild.id, member.id, 'remove', roleId, async () => {
        await member.roles.remove(roleId, 'BrawlHub club role refresh');
      });
    }
    cleaned += 1;
  }
  return cleaned;
}

/** Full guild-scoped club-rank role refresh for one Discord guild. */
export async function refreshGuildClubRoles(
  guild: Guild,
  options: ClubRoleServiceOptions & { readonly actor?: AdminActor | null } = {},
): Promise<ClubRoleRefreshResult> {
  const db = dbFor(options);
  const state = await loadGuildClubRoleState(guild.id, { db });
  const managedIds = managedRoleIds(state.mapping);
  if (managedIds.length === 0) {
    return { configured: false, planned: 0, processed: 0, membersNotFound: 0, cleanedMembers: 0 };
  }

  const links = await listGuildVerifiedLinks(guild.id, { db });
  const membershipRead = await readGuildMembershipRolesRead(
    guild.id,
    links.map((link) => link.playerId),
    { db },
  );
  const plans = buildClubRolePlans(
    links.map((link) => ({
      discordUserId: link.discordUserId,
      playerId: link.playerId,
      isMain: link.isMain,
    })),
    membershipRead.roles,
    state.mapping,
  );
  const result = await applyClubRolePlans(guild, plans);
  // Removing roles is destructive: only do it when every eligible membership
  // was actually resolved. A capped, repeated or malformed page must not be
  // treated as proof that a member is no longer eligible.
  const cleanedMembers = membershipRead.complete
    ? await removeStaleManagedRoles(
        guild,
        managedIds,
        new Set(plans.map((plan) => plan.discordUserId)),
      )
    : 0;
  if (!membershipRead.complete) {
    logger.warn('Skipping stale club role cleanup after an incomplete eligibility read', {
      guildId: guild.id,
    });
  }

  if (options.actor != null) {
    await recordAdminAudit(
      {
        actor: options.actor,
        action: 'guild.club_roles.refreshed',
        targetType: 'guild',
        targetId: guild.id,
        guildId: guild.id,
        details: {
          planned: plans.length,
          processed: result.processed,
          membersNotFound: result.membersNotFound,
          cleanedMembers,
        },
      },
      { db, guildId: guild.id },
    );
  }

  return { configured: true, planned: plans.length, ...result, cleanedMembers };
}

/** Refresh one Discord user's club-rank role from verified main accounts. */
export async function refreshMemberClubRoles(
  guild: Guild,
  discordUserId: string,
  options: ClubRoleServiceOptions = {},
): Promise<{
  readonly kind: 'not-configured' | 'not-verified' | 'not-member' | 'ok';
  readonly rank: ClubRoleRank | null;
}> {
  const db = dbFor(options);
  const state = await loadGuildClubRoleState(guild.id, { db });
  if (managedRoleIds(state.mapping).length === 0) {
    return { kind: 'not-configured', rank: null };
  }

  const links = await listGuildVerifiedLinks(guild.id, { db });
  const memberLinks = links.filter((link) => link.discordUserId === discordUserId);
  if (memberLinks.length === 0) return { kind: 'not-verified', rank: null };

  const membershipRoles = await readGuildMembershipRoles(
    guild.id,
    memberLinks.map((link) => link.playerId),
    { db },
  );
  const plans = buildClubRolePlans(
    memberLinks.map((link) => ({
      discordUserId: link.discordUserId,
      playerId: link.playerId,
      isMain: link.isMain,
    })),
    membershipRoles,
    state.mapping,
  );
  const result = await applyClubRolePlans(guild, plans);
  return {
    kind: result.processed === 0 ? 'not-member' : 'ok',
    rank: plans[0]?.rank ?? null,
  };
}

/**
 * Refresh every guild that has club roles configured. Used after a successful
 * sync batch; guilds are fetched by their own ID and all data remains scoped
 * to that guild.
 */
export async function refreshAllConfiguredClubRoles(
  client: Client,
  options: ClubRoleServiceOptions = {},
): Promise<RefreshAllClubRolesResult> {
  const db = dbFor(options);
  const result = await db
    .from('guild_settings')
    .select('guild_id, club_role_ids');
  requireOk(result.error, 'Read guilds with club role settings');

  const totals: { -readonly [K in keyof RefreshAllClubRolesResult]: RefreshAllClubRolesResult[K] } = {
    guilds: 0,
    planned: 0,
    processed: 0,
    membersNotFound: 0,
    cleanedMembers: 0,
    errors: 0,
  };

  for (const value of result.data ?? []) {
    const row = record(value);
    const guildId = asString(row?.['guild_id']);
    if (guildId === null || Object.keys(parseMapping(row?.['club_role_ids'])).length === 0) {
      continue;
    }

    let guild: Guild | null = null;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch {
      totals.errors += 1;
      continue;
    }

    try {
      const refreshed = await refreshGuildClubRoles(guild, { db });
      if (!refreshed.configured) continue;
      totals.guilds += 1;
      totals.planned += refreshed.planned;
      totals.processed += refreshed.processed;
      totals.membersNotFound += refreshed.membersNotFound;
      totals.cleanedMembers += refreshed.cleanedMembers;
    } catch (error) {
      totals.errors += 1;
      logger.warn('Club role refresh failed for one guild', {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return totals;
}
