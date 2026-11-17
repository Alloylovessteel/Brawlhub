import type { Role } from '@brawlhub/shared';
import type { DiscordRoleMap } from './config';

export interface ClubRef {
  id: string;
  tag: string;
}

export interface GuildMembership {
  id: string;
  owner: boolean;
  ownerId?: string;
  roles: string[];
}

export interface RoleGrant {
  scope: 'global' | 'club';
  clubId: string | null;
  role: Role;
}

function addGrant(grants: Map<string, RoleGrant>, grant: RoleGrant): void {
  const key = `${grant.scope}:${grant.clubId ?? ''}`;
  const existing = grants.get(key);
  const rank: Record<Role, number> = { owner: 3, admin: 2, staff: 1, member: 0 };
  if (existing === undefined || rank[grant.role] > rank[existing.role]) {
    grants.set(key, grant);
  }
}

/**
 * Derives BrawlHub grants from verified Discord guild membership.
 *
 * Only configured Discord role IDs are trusted. A verified guild member with
 * no elevated mapping receives read-only member access for each club.
 */
export function deriveRoleGrants(input: {
  discordUserId: string;
  guild: GuildMembership;
  roleMap: DiscordRoleMap;
  ownerRoleIds: string[];
  adminRoleIds: string[];
  clubs: ClubRef[];
}): RoleGrant[] {
  const grants = new Map<string, RoleGrant>();
  const discordRoles = new Set(input.guild.roles);
  const hasAnyRole = (roleIds: string[]): boolean => roleIds.some((id) => discordRoles.has(id));

  const isGuildOwner =
    input.guild.owner ||
    (input.guild.ownerId !== undefined && input.guild.ownerId === input.discordUserId);

  if (isGuildOwner || hasAnyRole(input.ownerRoleIds)) {
    addGrant(grants, { scope: 'global', clubId: null, role: 'owner' });
  }
  if (hasAnyRole(input.adminRoleIds)) {
    addGrant(grants, { scope: 'global', clubId: null, role: 'admin' });
  }

  for (const club of input.clubs) {
    const mapping = input.roleMap.clubs[club.tag];
    if (mapping !== undefined && hasAnyRole(mapping.presidentRoleIds)) {
      addGrant(grants, { scope: 'club', clubId: club.id, role: 'owner' });
    } else if (mapping !== undefined && hasAnyRole(mapping.staffRoleIds)) {
      addGrant(grants, { scope: 'club', clubId: club.id, role: 'staff' });
    } else {
      addGrant(grants, { scope: 'club', clubId: club.id, role: 'member' });
    }
  }

  return [...grants.values()];
}
