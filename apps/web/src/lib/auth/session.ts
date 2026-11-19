import { createTrustedClient } from '@brawlhub/database';
import { hasPermission, type Permission, type Role } from '@brawlhub/shared';
import type { User } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase';
import type { RoleGrant } from './roles';

interface ProfileRow {
  id: string;
  discord_user_id: string;
  username: string | null;
  avatar_url: string | null;
}

interface RoleRow {
  scope: 'global' | 'club';
  club_id: string | null;
  role: Role;
}

export interface AppSession {
  user: User;
  profile: ProfileRow | null;
  grants: RoleGrant[];
  globalRole: Role | null;
  clubRoles: Map<string, Role>;
}

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, staff: 1, member: 0 };

/** Loads the authenticated user and their database-backed BrawlHub grants. */
export async function getAppSession(): Promise<AppSession | null> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) return null;

  const db = createTrustedClient();
  const [profileResult, rolesResult] = await Promise.all([
    db
      .from('profiles')
      .select('id, discord_user_id, username, avatar_url')
      .eq('id', user.id)
      .maybeSingle(),
    db.from('user_roles').select('scope, club_id, role').eq('user_id', user.id),
  ]);

  const profile = (profileResult.data ?? null) as ProfileRow | null;
  const rows = (rolesResult.data ?? []) as RoleRow[];

  let globalRole: Role | null = null;
  const clubRoles = new Map<string, Role>();
  for (const row of rows) {
    if (row.scope === 'global') {
      if (globalRole === null || ROLE_RANK[row.role] > ROLE_RANK[globalRole]) {
        globalRole = row.role;
      }
    } else if (row.club_id !== null) {
      const existing = clubRoles.get(row.club_id);
      if (existing === undefined || ROLE_RANK[row.role] > ROLE_RANK[existing]) {
        clubRoles.set(row.club_id, row.role);
      }
    }
  }

  return {
    user,
    profile,
    grants: rows.map((row) => ({
      scope: row.scope,
      clubId: row.club_id,
      role: row.role,
    })),
    globalRole,
    clubRoles,
  };
}

export function hasGlobalPermission(session: AppSession, permission: Permission): boolean {
  return session.globalRole !== null && hasPermission(session.globalRole, permission);
}

export function hasClubPermission(
  session: AppSession,
  clubId: string,
  permission: Permission,
): boolean {
  if (hasGlobalPermission(session, permission)) return true;
  const role = session.clubRoles.get(clubId);
  return role !== undefined && hasPermission(role, permission);
}

export function canManageClub(session: AppSession, clubId: string): boolean {
  return hasClubPermission(session, clubId, 'clubs:write');
}

export function isGlobalAdmin(session: AppSession): boolean {
  return session.globalRole === 'owner' || session.globalRole === 'admin';
}

export async function requirePageSession(): Promise<AppSession> {
  const session = await getAppSession();
  if (session === null || session.profile === null) {
    redirect('/login');
  }
  return session;
}

export async function requirePageGlobalPermission(permission: Permission): Promise<AppSession> {
  const session = await requirePageSession();
  if (!hasGlobalPermission(session, permission)) {
    redirect('/access-denied');
  }
  return session;
}

export async function requirePageClubPermission(
  clubId: string,
  permission: Permission,
): Promise<AppSession> {
  const session = await requirePageSession();
  if (!hasClubPermission(session, clubId, permission)) {
    redirect('/access-denied');
  }
  return session;
}

/**
 * Returns club IDs the session may read for dashboard data.
 * `null` means unrestricted (global read access). An empty array means none.
 */
export function getAccessibleReadClubIds(session: AppSession): string[] | null {
  if (hasGlobalPermission(session, 'clubs:read') || hasGlobalPermission(session, 'players:read')) {
    return null;
  }
  return [...session.clubRoles.keys()];
}

export function isClubInReadScope(clubId: string, scope: string[] | null): boolean {
  return scope === null || scope.includes(clubId);
}
