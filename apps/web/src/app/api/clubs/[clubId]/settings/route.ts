import { createTrustedClient } from '@brawlhub/database';
import { discordIdSchema } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, requireApiClubPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const optionalSnowflakeSchema = z
  .union([z.literal(''), discordIdSchema])
  .transform((value) => (value === '' ? null : value));

const settingsSchema = z.object({
  announcement_channel_id: optionalSnowflakeSchema,
  verified_role_id: optionalSnowflakeSchema,
  notes: z
    .string()
    .trim()
    .max(2000, 'Notes must be 2000 characters or fewer.')
    .transform((value) => (value.length === 0 ? null : value)),
});

function redirectToClub(
  request: NextRequest,
  clubId: string,
  status: 'saved' | 'invalid' | 'failed',
): NextResponse {
  const url = new URL(`/dashboard/clubs/${clubId}`, request.nextUrl.origin);
  url.searchParams.set(status === 'saved' ? 'saved' : 'error', '1');
  return NextResponse.redirect(url, 303);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ clubId: string }> },
): Promise<NextResponse> {
  const originError = sameOriginGuard(request);
  if (originError !== null) return originError;

  const { clubId } = await context.params;
  const parsedClubId = z.uuid().safeParse(clubId);
  if (!parsedClubId.success) return jsonError(400, 'invalid_club_id');

  const guard = await requireApiClubPermission(parsedClubId.data, 'clubs:write');
  if ('response' in guard) return guard.response;

  const rateLimit = checkRateLimit(`club-settings:${guard.session.profile!.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return jsonError(429, 'rate_limited', 'Too many settings updates. Please try again shortly.');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return redirectToClub(request, parsedClubId.data, 'invalid');
  }

  const parsed = settingsSchema.safeParse({
    announcement_channel_id: formData.get('announcement_channel_id'),
    verified_role_id: formData.get('verified_role_id'),
    notes: formData.get('notes'),
  });
  if (!parsed.success) return redirectToClub(request, parsedClubId.data, 'invalid');

  const db = createTrustedClient();
  const { announcement_channel_id, verified_role_id, notes } = parsed.data;

  try {
    const club = await db
      .from('clubs')
      .select('guild_id')
      .eq('id', parsedClubId.data)
      .maybeSingle();
    if (club.error !== null && club.error !== undefined) {
      throw new Error(club.error.message);
    }
    const guildId =
      typeof (club.data as { guild_id?: unknown } | null)?.guild_id === 'string'
        ? ((club.data as { guild_id: string }).guild_id)
        : null;

    const existing = await db
      .from('club_private')
      .select('announcement_channel_id, verified_role_id, notes')
      .eq('club_id', parsedClubId.data)
      .maybeSingle();
    if (existing.error !== null && existing.error !== undefined) {
      throw new Error(existing.error.message);
    }

    const saved = await db.from('club_private').upsert(
      {
        club_id: parsedClubId.data,
        announcement_channel_id,
        verified_role_id,
        notes,
      },
      { onConflict: 'club_id' },
    );
    if (saved.error !== null && saved.error !== undefined) {
      throw new Error(saved.error.message);
    }

    const before = existing.data as
      | { announcement_channel_id: string | null; verified_role_id: string | null; notes: string | null }
      | null;
    const changedFields = [
      before === null || before.announcement_channel_id !== announcement_channel_id
        ? 'announcement_channel_id'
        : null,
      before === null || before.verified_role_id !== verified_role_id ? 'verified_role_id' : null,
      before === null || before.notes !== notes ? 'notes' : null,
    ].filter((field): field is string => field !== null);

    const audit = await db.from('audit_logs').insert({
      actor_profile_id: guard.session.profile!.id,
      action: 'club.settings.updated',
      target_type: 'club',
      target_id: parsedClubId.data,
      guild_id: guildId,
      details: { changedFields },
    });
    if (audit.error !== null && audit.error !== undefined) {
      throw new Error(`Settings saved but audit logging failed: ${audit.error.message}`);
    }

    return redirectToClub(request, parsedClubId.data, 'saved');
  } catch (error) {
    console.error(
      'Club settings update failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    return redirectToClub(request, parsedClubId.data, 'failed');
  }
}
