import { createTrustedClient } from '@brawlhub/database';
import { discordIdSchema } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, requireApiGlobalPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { canAdministerRoleChange } from '@/lib/auth/role-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const roleSchema = z.enum(['owner', 'admin', 'staff', 'member']);

const roleRequestSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  discordUserId: discordIdSchema,
  scope: z.enum(['global', 'club']),
  role: roleSchema,
  clubId: z.string().trim().optional().default(''),
});

function redirectToAdmin(request: NextRequest, status: 'success' | 'error'): NextResponse {
  const url = new URL('/dashboard/admin', request.nextUrl.origin);
  url.searchParams.set('role', status);
  url.searchParams.set('tab', 'roles');
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = sameOriginGuard(request);
  if (originError !== null) return originError;

  const guard = await requireApiGlobalPermission('staff:manage');
  if ('response' in guard) return guard.response;

  const rateLimit = checkRateLimit(`admin-roles:${guard.session.profile!.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return jsonError(429, 'rate_limited', 'Too many role changes. Please try again shortly.');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, 'invalid_request');
  }

  const parsed = roleRequestSchema.safeParse({
    action: formData.get('action'),
    discordUserId: formData.get('discordUserId'),
    scope: formData.get('scope'),
    role: formData.get('role'),
    clubId: formData.get('clubId') ?? '',
  });
  if (!parsed.success) return redirectToAdmin(request, 'error');

  const { action, discordUserId, scope, role, clubId } = parsed.data;
  if (scope === 'club' && clubId === '') return redirectToAdmin(request, 'error');
  if (scope === 'global' && clubId !== '') return redirectToAdmin(request, 'error');

  let parsedClubId: string | undefined;
  if (clubId !== '') {
    const club = z.uuid().safeParse(clubId);
    if (!club.success) return redirectToAdmin(request, 'error');
    parsedClubId = club.data;
  }

  if (
    action === 'revoke' &&
    scope === 'global' &&
    role === 'owner' &&
    discordUserId === guard.session.profile!.discord_user_id
  ) {
    return jsonError(403, 'cannot_revoke_self', 'You cannot revoke your own global owner role.');
  }

  const db = createTrustedClient();

  try {
    const targetProfile = await db
      .from('profiles')
      .select('id')
      .eq('discord_user_id', discordUserId)
      .maybeSingle();
    if (targetProfile.error !== null && targetProfile.error !== undefined) {
      throw new Error(targetProfile.error.message);
    }
    if (targetProfile.data === null) return redirectToAdmin(request, 'error');

    let guildId: string | null = null;
    if (parsedClubId !== undefined) {
      const club = await db
        .from('clubs')
        .select('id, guild_id')
        .eq('id', parsedClubId)
        .is('archived_at', null)
        .maybeSingle();
      if (club.error !== null && club.error !== undefined) throw new Error(club.error.message);
      if (club.data === null) return redirectToAdmin(request, 'error');
      const clubRow = club.data as { guild_id?: string | null } | null;
      guildId = typeof clubRow?.guild_id === 'string' ? clubRow.guild_id : null;
    }

    let currentRolesQuery = db
      .from('user_roles')
      .select('role')
      .eq('user_id', targetProfile.data.id as string)
      .eq('scope', scope);
    currentRolesQuery =
      parsedClubId === undefined
        ? currentRolesQuery.is('club_id', null)
        : currentRolesQuery.eq('club_id', parsedClubId);
    const currentRolesResult = await currentRolesQuery;
    if (currentRolesResult.error !== null && currentRolesResult.error !== undefined) {
      throw new Error(currentRolesResult.error.message);
    }
    const existingRoles = (currentRolesResult.data ?? [])
      .map((row) => roleSchema.safeParse((row as { role?: unknown })?.role))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    const actorGlobalRole = guard.session.globalRole ?? 'member';
    const actorClubRole =
      parsedClubId === undefined ? undefined : guard.session.clubRoles.get(parsedClubId);
    if (
      !canAdministerRoleChange(
        { globalRole: actorGlobalRole, clubRole: actorClubRole },
        scope,
        role,
        existingRoles,
      )
    ) {
      return jsonError(403, 'forbidden', 'You cannot grant or revoke this role.');
    }

    if (action === 'grant') {
      // Upsert against the same unique key the schema uses, so a grant never
      // leaves the target without a row between a delete and an insert.
      const saved = await db.from('user_roles').upsert(
        {
          user_id: targetProfile.data.id as string,
          scope,
          club_id: parsedClubId ?? null,
          role,
          source: 'manual',
          granted_by: guard.session.profile!.id,
        },
        { onConflict: 'user_id,scope,club_id' },
      );
      if (saved.error !== null && saved.error !== undefined) throw new Error(saved.error.message);
    } else {
      let deleteQuery = db
        .from('user_roles')
        .delete()
        .eq('user_id', targetProfile.data.id as string)
        .eq('scope', scope);
      deleteQuery =
        parsedClubId === undefined
          ? deleteQuery.is('club_id', null)
          : deleteQuery.eq('club_id', parsedClubId);
      const removed = await deleteQuery;
      if (removed.error !== null && removed.error !== undefined) throw new Error(removed.error.message);
    }

    const audit = await db.from('audit_logs').insert({
      actor_profile_id: guard.session.profile!.id,
      action: action === 'grant' ? 'role.granted' : 'role.revoked',
      target_type: 'profile',
      target_id: targetProfile.data.id as string,
      guild_id: guildId,
      details: { discordUserId, scope, role, clubId: parsedClubId ?? null },
    });
    if (audit.error !== null && audit.error !== undefined) {
      throw new Error(`Role saved but audit logging failed: ${audit.error.message}`);
    }

    return redirectToAdmin(request, 'success');
  } catch (error) {
    console.error('Role administration failed', error instanceof Error ? error.message : 'unknown error');
    return redirectToAdmin(request, 'error');
  }
}
