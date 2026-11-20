import { createTrustedClient } from '@brawlhub/database';
import { discordIdSchema } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, requireApiGlobalPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const snowflakeOrEmpty = z
  .union([z.literal(''), discordIdSchema])
  .transform((value) => (value === '' ? null : value));

const guildSettingsSchema = z.object({
  guildId: discordIdSchema,
  announcementChannelId: snowflakeOrEmpty,
  verifiedRoleId: snowflakeOrEmpty,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = sameOriginGuard(request);
  if (originError !== null) return originError;

  const guard = await requireApiGlobalPermission('clubs:write');
  if ('response' in guard) return guard.response;

  const rateLimit = checkRateLimit(`guild-settings:${guard.session.profile!.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return jsonError(429, 'rate_limited', 'Too many settings updates. Please try again shortly.');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, 'invalid_request');
  }

  const parsed = guildSettingsSchema.safeParse({
    guildId: formData.get('guildId'),
    announcementChannelId: formData.get('announcementChannelId') ?? '',
    verifiedRoleId: formData.get('verifiedRoleId') ?? '',
  });
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const db = createTrustedClient();
  const redirectWith = (status: 'success' | 'error'): NextResponse => {
    const url = new URL('/dashboard/admin', request.nextUrl.origin);
    url.searchParams.set('settings', status);
    url.searchParams.set('tab', 'settings');
    return NextResponse.redirect(url, 303);
  };

  try {
    const saved = await db.from('guild_settings').upsert(
      {
        guild_id: parsed.data.guildId,
        announcement_channel_id: parsed.data.announcementChannelId,
        verified_role_id: parsed.data.verifiedRoleId,
      },
      { onConflict: 'guild_id' },
    );
    if (saved.error !== null && saved.error !== undefined) throw new Error(saved.error.message);

    const audit = await db.from('audit_logs').insert({
      actor_profile_id: guard.session.profile!.id,
      action: 'guild.settings.updated',
      target_type: 'guild',
      target_id: parsed.data.guildId,
      guild_id: parsed.data.guildId,
      details: { changedFields: ['announcementChannelId', 'verifiedRoleId'] },
    });
    if (audit.error !== null && audit.error !== undefined) {
      throw new Error(`Guild settings saved but audit logging failed: ${audit.error.message}`);
    }

    return redirectWith('success');
  } catch (error) {
    console.error('Guild settings update failed', error instanceof Error ? error.message : 'unknown error');
    return redirectWith('error');
  }
}
