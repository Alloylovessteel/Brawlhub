import { createTrustedClient } from '@brawlhub/database';
import {
  discordIdSchema,
  hasPermission,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@brawlhub/shared';
import { asString, record, requireOk } from '../clubs/service';
import type { StaffActor, StaffListView, StaffMember, StaffRoleEntry } from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const ROLES: readonly Role[] = ['owner', 'admin', 'staff', 'member'];
const STAFF_ROLES: readonly Role[] = ['owner', 'admin', 'staff'];
const ROLE_RANK: Readonly<Record<Role, number>> = { owner: 3, admin: 2, staff: 1, member: 0 };

/** Canonical permission order: the widest role first, then any additions. */
const PERMISSION_ORDER: readonly Permission[] = [
  ...new Set<Permission>([
    ...ROLE_PERMISSIONS.owner,
    ...ROLE_PERMISSIONS.admin,
    ...ROLE_PERMISSIONS.staff,
    ...ROLE_PERMISSIONS.member,
  ]),
];

const PROFILE_NOT_LINKED_MESSAGE =
  'Your Discord account is not linked to BrawlHub. Sign in to the website first.';

/** Expected, user-facing staff failures; raw database errors remain hidden. */
export class StaffServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StaffServiceError';
    this.code = code;
  }
}

export interface StaffServiceOptions {
  readonly db?: DatabaseClient;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function isStaffRole(value: unknown): value is Role {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}

function higherRole(current: Role | null, candidate: Role): Role {
  return current === null || ROLE_RANK[candidate] > ROLE_RANK[current] ? candidate : current;
}

/**
 * Resolve a Discord snowflake to the linked profile and its highest global
 * role. Club-scoped roles are deliberately not part of the staff actor.
 */
export async function resolveStaffActor(
  discordUserId: string,
  options: StaffServiceOptions = {},
): Promise<StaffActor> {
  const parsedId = discordIdSchema.safeParse(discordUserId);
  if (!parsedId.success) {
    throw new StaffServiceError('profile_not_linked', PROFILE_NOT_LINKED_MESSAGE);
  }
  const discordId = parsedId.data;
  const db = options.db ?? createTrustedClient();

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, discord_user_id')
    .eq('discord_user_id', discordId)
    .maybeSingle();
  requireOk(profileError, 'Read profile');

  const profileRow = record(profile);
  const profileId = asString(profileRow?.['id']);
  if (profileRow === null || profileId === null) {
    throw new StaffServiceError('profile_not_linked', PROFILE_NOT_LINKED_MESSAGE);
  }

  const { data: roleRows, error: roleError } = await db
    .from('user_roles')
    .select('scope, club_id, role')
    .eq('user_id', profileId);
  requireOk(roleError, 'Read user roles');

  let globalRole: Role | null = null;
  for (const value of roleRows ?? []) {
    const row = record(value);
    if (row === null || row['scope'] !== 'global' || !isRole(row['role'])) continue;
    globalRole = higherRole(globalRole, row['role']);
  }

  return { profileId, discordUserId: discordId, globalRole };
}

/** Staff management is a global-only permission; club roles never grant it. */
export function canManageStaff(actor: StaffActor): boolean {
  return actor.globalRole !== null && hasPermission(actor.globalRole, 'staff:manage');
}

interface ClubRef {
  readonly tag: string | null;
  readonly name: string | null;
}

function compareRoleEntries(first: StaffRoleEntry, second: StaffRoleEntry): number {
  if (first.scope !== second.scope) return first.scope === 'global' ? -1 : 1;
  if (first.scope === 'global') return ROLE_RANK[second.role] - ROLE_RANK[first.role];

  const names = (first.clubName ?? first.clubTag ?? '').localeCompare(
    second.clubName ?? second.clubTag ?? '',
  );
  if (names !== 0) return names;
  const tags = (first.clubTag ?? '').localeCompare(second.clubTag ?? '');
  if (tags !== 0) return tags;
  return ROLE_RANK[second.role] - ROLE_RANK[first.role];
}

function unionPermissions(roles: readonly StaffRoleEntry[]): Permission[] {
  return PERMISSION_ORDER.filter((permission) =>
    roles.some((entry) => ROLE_PERMISSIONS[entry.role].includes(permission)),
  );
}

function compareMembers(first: StaffMember, second: StaffMember): number {
  const firstLabel = first.discordUsername ?? `Discord ID ${first.discordUserId}`;
  const secondLabel = second.discordUsername ?? `Discord ID ${second.discordUserId}`;
  const labels = firstLabel.localeCompare(secondLabel);
  if (labels !== 0) return labels;
  return first.profileId.localeCompare(second.profileId);
}

/** Load all global and club staff assignments for the paginated `/staff list` view. */
export async function listStaff(options: StaffServiceOptions = {}): Promise<StaffListView> {
  const db = options.db ?? createTrustedClient();
  const [roleRows, profileRows, clubRows, discordRows] = await Promise.all([
    db.from('user_roles').select('user_id, scope, club_id, role, created_at'),
    db.from('profiles').select('id, discord_user_id'),
    db.from('clubs').select('id, tag, name'),
    db.from('discord_users').select('discord_user_id, username'),
  ]);
  requireOk(roleRows.error, 'Read user roles');
  requireOk(profileRows.error, 'Read profiles');
  requireOk(clubRows.error, 'Read clubs');
  requireOk(discordRows.error, 'Read Discord users');

  const discordIdsByProfile = new Map<string, string>();
  for (const value of profileRows.data ?? []) {
    const row = record(value);
    const profileId = asString(row?.['id']);
    const discordUserId = asString(row?.['discord_user_id']);
    if (profileId !== null && discordUserId !== null) {
      discordIdsByProfile.set(profileId, discordUserId);
    }
  }

  const usernamesById = new Map<string, string>();
  for (const value of discordRows.data ?? []) {
    const row = record(value);
    const discordUserId = asString(row?.['discord_user_id']);
    const username = asString(row?.['username']);
    if (discordUserId !== null && username !== null) usernamesById.set(discordUserId, username);
  }

  const clubsById = new Map<string, ClubRef>();
  for (const value of clubRows.data ?? []) {
    const row = record(value);
    const clubId = asString(row?.['id']);
    if (clubId === null) continue;
    clubsById.set(clubId, { tag: asString(row?.['tag']), name: asString(row?.['name']) });
  }

  const rolesByProfile = new Map<string, StaffRoleEntry[]>();
  let globalCount = 0;
  let clubCount = 0;
  for (const value of roleRows.data ?? []) {
    const row = record(value);
    if (row === null || !isStaffRole(row['role'])) continue;
    const scope = row['scope'];
    if (scope !== 'global' && scope !== 'club') continue;
    const profileId = asString(row['user_id']);
    if (profileId === null || !discordIdsByProfile.has(profileId)) continue;

    const clubId = scope === 'club' ? asString(row['club_id']) : null;
    if (scope === 'club' && clubId === null) continue;
    const club = clubId === null ? null : clubsById.get(clubId) ?? null;
    const entry: StaffRoleEntry = {
      scope,
      role: row['role'],
      clubId,
      clubTag: club?.tag ?? null,
      clubName: club?.name ?? null,
      // user_roles stores the grant time in created_at; tolerate legacy seeds.
      grantedAt: asString(row['created_at']) ?? asString(row['granted_at']),
    };
    const entries = rolesByProfile.get(profileId);
    if (entries === undefined) rolesByProfile.set(profileId, [entry]);
    else entries.push(entry);
    if (scope === 'global') globalCount += 1;
    else clubCount += 1;
  }

  const entries: StaffMember[] = [];
  for (const [profileId, roles] of rolesByProfile) {
    const orderedRoles = [...roles].sort(compareRoleEntries);
    const discordUserId = discordIdsByProfile.get(profileId) ?? '';
    let highestGlobalRole: Role | null = null;
    for (const role of orderedRoles) {
      if (role.scope === 'global') highestGlobalRole = higherRole(highestGlobalRole, role.role);
    }
    entries.push({
      profileId,
      discordUserId,
      discordUsername: usernamesById.get(discordUserId) ?? null,
      roles: orderedRoles,
      highestGlobalRole,
      permissions: unionPermissions(orderedRoles),
    });
  }

  return {
    entries: entries.sort(compareMembers),
    globalCount,
    clubCount,
    generatedAt: new Date(),
  };
}
