import type { APIInteractionGuildMember, GuildMember } from 'discord.js';

/** Best-effort extraction of Discord role IDs for the invoking guild member. */
export function getInteractionMemberRoleIds(
  member: GuildMember | APIInteractionGuildMember | null | undefined,
): readonly string[] | null {
  if (member == null) return null;
  if (Array.isArray((member as { roles?: unknown }).roles)) {
    return (member as { roles: string[] }).roles;
  }
  const roles = (member as GuildMember).roles;
  if (roles && typeof roles === 'object' && 'cache' in roles) {
    try {
      return [...(roles as GuildMember['roles']).cache.keys()];
    } catch {
      return null;
    }
  }
  return null;
}
