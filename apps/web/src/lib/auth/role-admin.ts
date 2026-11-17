import type { Role } from '@brawlhub/shared';

export type RoleScope = 'global' | 'club';

/** Server-side rules for manual role administration. Never driven by the client. */
export function canAdministerRole(
  actor: { globalRole: Role | null; clubRole?: Role | undefined },
  scope: RoleScope,
  targetRole: Role,
): boolean {
  if (actor.globalRole === 'owner') {
    if (scope === 'global') return true;
    return targetRole === 'owner' || targetRole === 'staff' || targetRole === 'member';
  }

  if (actor.globalRole === 'admin') {
    return scope === 'club' && (targetRole === 'staff' || targetRole === 'member');
  }

  return scope === 'club' && actor.clubRole === 'owner' && (targetRole === 'staff' || targetRole === 'member');
}
