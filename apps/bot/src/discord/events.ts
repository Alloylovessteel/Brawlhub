import { createLogger } from '@brawlhub/logging';
import type { Client, GuildMember, Role } from 'discord.js';

type MemberSnapshot = Pick<GuildMember, 'guild' | 'user' | 'roles'>;

const logger = createLogger('bot');

export interface RoleUpdateChange {
  readonly type: 'guild_role_update';
  readonly guildId: string;
  readonly roleId: string;
  readonly nameChanged: boolean;
  readonly positionChanged: boolean;
  readonly permissionsChanged: boolean;
}

export interface RoleDeleteChange {
  readonly type: 'guild_role_delete';
  readonly guildId: string;
  readonly roleId: string;
  readonly position: number;
  readonly permissionBitfield: string;
}

export interface MemberUpdateChange {
  readonly type: 'guild_member_update';
  readonly guildId: string;
  readonly userId: string;
  readonly rolesAdded: readonly string[];
  readonly rolesRemoved: readonly string[];
  readonly roleCount: number;
}

export type DiscordAuthorizationChange = RoleUpdateChange | RoleDeleteChange | MemberUpdateChange;

function permissionBitfield(role: Role): string {
  return role.permissions.bitfield.toString();
}

function roleIds(member: MemberSnapshot): Iterable<string> {
  return member.roles.cache.keys();
}

/** Build a compact change record without persisting or mutating Discord state. */
export function buildRoleUpdateChange(oldRole: Role, newRole: Role): RoleUpdateChange {
  return {
    type: 'guild_role_update',
    guildId: newRole.guild.id,
    roleId: newRole.id,
    nameChanged: oldRole.name !== newRole.name,
    positionChanged: oldRole.position !== newRole.position,
    permissionsChanged: permissionBitfield(oldRole) !== permissionBitfield(newRole),
  };
}

/** Build a compact change record for a deleted role. */
export function buildRoleDeleteChange(role: Role): RoleDeleteChange {
  return {
    type: 'guild_role_delete',
    guildId: role.guild.id,
    roleId: role.id,
    position: role.position,
    permissionBitfield: permissionBitfield(role),
  };
}

/** Build the role-assignment delta needed by the future permission recalculator. */
export function buildMemberUpdateChange(
  oldMember: MemberSnapshot,
  newMember: MemberSnapshot
): MemberUpdateChange {
  const before = new Set(roleIds(oldMember));
  const after = new Set(roleIds(newMember));

  return {
    type: 'guild_member_update',
    guildId: newMember.guild.id,
    userId: newMember.user.id,
    rolesAdded: [...after].filter((roleId) => !before.has(roleId)).sort(),
    rolesRemoved: [...before].filter((roleId) => !after.has(roleId)).sort(),
    roleCount: after.size,
  };
}

function logChange(change: DiscordAuthorizationChange): void {
  logger.info('Observed Discord authorization-relevant change', { change });
}

/**
 * Register the Gateway events Phase 3.5 will use to recalculate permissions.
 *
 * This phase only observes and logs the changes. The optional callback gives the
 * later recalculation service a single insertion point without changing any
 * mappings, database records, or Discord roles now.
 */
export function registerDiscordAuthorizationEvents(
  client: Client,
  configuredGuildId: string | undefined,
  onEvent: (change: DiscordAuthorizationChange) => void = logChange
): void {
  const report = (change: DiscordAuthorizationChange): void => {
    if (configuredGuildId !== undefined && change.guildId !== configuredGuildId) {
      return;
    }
    onEvent(change);
  };

  client.on('guildRoleUpdate', (oldRole: Role, newRole: Role) => {
    report(buildRoleUpdateChange(oldRole, newRole));
  });

  client.on('guildRoleDelete', (role: Role) => {
    report(buildRoleDeleteChange(role));
  });

  client.on('guildMemberUpdate', (oldMember, newMember) => {
    report(buildMemberUpdateChange(oldMember, newMember));
  });
}
