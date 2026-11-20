import { createTrustedClient } from '@brawlhub/database';
import { discordIdSchema } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireApiClubPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { canAdministerRole } from '@/lib/auth/role-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const staffRequestSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  discordUserId: discordIdSchema,
  role: z.enum(['staff', 'member']),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ clubId: string }> },
): Promise<NextResponse> {
  const originError = sameOriginGuard(request);
  if (originError !== null) return originError;

  const { clubId } = await context.params;
  const parsedClubId = z.uuid().safeParse(clubId);
  if (!parsedClubId.success) {
    return NextResponse.json({ error: 'invalid_club_id' }, { status: 400 });
  }

  const guard = await requireApiClubPermission(parsedClubId.data, 'staff:manage');
  if ('response' in guard) return guard.response;

  const rateLimit = checkRateLimit(`club-staff:${guard.session.profile!.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const parsed = staffRequestSchema.safeParse({
    action: formData.get('action'),
    discordUserId: formData.get('discordUserId'),
    role: formData.get('role'),
  });
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const actorGlobalRole = guard.session.globalRole ?? 'member';
  if (
    !canAdministerRole(
      { globalRole: actorGlobalRole, clubRole: guard.session.clubRoles.get(parsedClubId.data) },
      'club',
      parsed.data.role,
    )
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const db = createTrustedClient();
  const redirectWith = (status: 'success' | 'error'): NextResponse => {
    const url = new URL(`/dashboard/clubs/${parsedClubId.data}`, request.nextUrl.origin);
    url.searchParams.set('staff', status);
    return NextResponse.redirect(url, 303);
  };

  try {
    const club = await db
      .from('clubs')
      .select('guild_id')
      .eq('id', parsedClubId.data)
      .is('archived_at', null)
      .maybeSingle();
    if (club.error !== null && club.error !== undefined) {
      throw new Error(club.error.message);
    }
    const guildId =
      typeof (club.data as { guild_id?: unknown } | null)?.guild_id === 'string'
        ? ((club.data as { guild_id: string }).guild_id)
        : null;

    const targetProfile = await db
      .from('profiles')
      .select('id')
      .eq('discord_user_id', parsed.data.discordUserId)
      .maybeSingle();
    if (targetProfile.error !== null && targetProfile.error !== undefined) {
      throw new Error(targetProfile.error.message);
    }
    if (targetProfile.data === null) return redirectWith('error');

    const removed = await db
      .from('user_roles')
      .delete()
      .eq('user_id', targetProfile.data.id as string)
      .eq('scope', 'club')
      .eq('club_id', parsedClubId.data);
    if (removed.error !== null && removed.error !== undefined) throw new Error(removed.error.message);

    if (parsed.data.action === 'grant') {
      const inserted = await db.from('user_roles').insert({
        user_id: targetProfile.data.id as string,
        scope: 'club',
        club_id: parsedClubId.data,
        role: parsed.data.role,
        source: 'manual',
        granted_by: guard.session.profile!.id,
      });
      if (inserted.error !== null && inserted.error !== undefined) throw new Error(inserted.error.message);
    }

    const audit = await db.from('audit_logs').insert({
      actor_profile_id: guard.session.profile!.id,
      action: parsed.data.action === 'grant' ? 'club.staff.granted' : 'club.staff.revoked',
      target_type: 'profile',
      target_id: targetProfile.data.id as string,
      guild_id: guildId,
      details: {
        clubId: parsedClubId.data,
        discordUserId: parsed.data.discordUserId,
        role: parsed.data.role,
      },
    });
    if (audit.error !== null && audit.error !== undefined) {
      throw new Error(`Staff role saved but audit logging failed: ${audit.error.message}`);
    }

    return redirectWith('success');
  } catch (error) {
    console.error('Club staff administration failed', error instanceof Error ? error.message : 'unknown error');
    return redirectWith('error');
  }
}
