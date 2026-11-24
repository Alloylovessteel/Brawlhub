import { createTrustedClient } from '@brawlhub/database';
import { discordIdSchema } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, requireApiGlobalPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';

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
    // Authorization, mutation and audit logging are one database transaction.
    // Re-reading stored roles inside the RPC closes the check-then-write race.
    const result = await db.rpc('apply_manual_role_change', {
      p_actor_profile_id: guard.session.profile!.id,
      p_discord_user_id: discordUserId,
      p_scope: scope,
      p_club_id: parsedClubId ?? null,
      p_role: role,
      p_action: action,
    });
    if (result.error !== null && result.error !== undefined) throw new Error(result.error.message);

    const outcome = result.data as { ok?: boolean; code?: string } | null;
    if (outcome?.ok === true) return redirectToAdmin(request, 'success');

    switch (outcome?.code) {
      case 'cannot_revoke_self':
        return jsonError(403, 'cannot_revoke_self', 'You cannot revoke your own global owner role.');
      case 'forbidden':
        return jsonError(403, 'forbidden', 'You cannot grant or revoke this role.');
      case 'invalid_request':
        return jsonError(400, 'invalid_request');
      default:
        return redirectToAdmin(request, 'error');
    }
  } catch (error) {
    console.error('Role administration failed', error instanceof Error ? error.message : 'unknown error');
    return redirectToAdmin(request, 'error');
  }
}
