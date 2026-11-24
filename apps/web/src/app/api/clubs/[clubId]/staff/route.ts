import { createTrustedClient } from '@brawlhub/database';
import { discordIdSchema } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireApiClubPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const roleSchema = z.enum(['owner', 'admin', 'staff', 'member']);

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

  const db = createTrustedClient();
  const redirectWith = (status: 'success' | 'error'): NextResponse => {
    const url = new URL(`/dashboard/clubs/${parsedClubId.data}`, request.nextUrl.origin);
    url.searchParams.set('staff', status);
    return NextResponse.redirect(url, 303);
  };

  try {
    // The RPC re-reads stored roles inside one transaction and writes the audit
    // row with the grant, so an overlapping grant change cannot bypass policy.
    const result = await db.rpc('apply_manual_role_change', {
      p_actor_profile_id: guard.session.profile!.id,
      p_discord_user_id: parsed.data.discordUserId,
      p_scope: 'club',
      p_club_id: parsedClubId.data,
      p_role: parsed.data.role,
      p_action: parsed.data.action,
    });
    if (result.error !== null && result.error !== undefined) throw new Error(result.error.message);

    const outcome = result.data as { ok?: boolean; code?: string } | null;
    if (outcome?.ok === true) return redirectWith('success');
    if (outcome?.code === 'forbidden') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    if (outcome?.code === 'invalid_request') {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    return redirectWith('error');
  } catch (error) {
    console.error('Club staff administration failed', error instanceof Error ? error.message : 'unknown error');
    return redirectWith('error');
  }
}
