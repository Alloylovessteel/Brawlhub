import { createTrustedClient } from '@brawlhub/database';
import { runSyncForAllGuilds } from '@brawlhub/sync';
import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, requireApiGlobalPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = sameOriginGuard(request);
  if (originError !== null) return originError;

  const guard = await requireApiGlobalPermission('sync:run');
  if ('response' in guard) return guard.response;

  const rateLimit = checkRateLimit(`admin-sync:${guard.session.profile!.id}`, 3, 60_000);
  if (!rateLimit.allowed) {
    return jsonError(429, 'rate_limited', 'Too many sync requests. Please wait before retrying.');
  }

  const redirectWith = (status: 'success' | 'failed'): NextResponse => {
    const url = new URL('/dashboard/admin', request.nextUrl.origin);
    url.searchParams.set('sync', status);
    return NextResponse.redirect(url, 303);
  };

  const db = createTrustedClient();

  try {
    const results = await runSyncForAllGuilds();
    const failed = results.some((entry) => entry.status === 'failed');
    const aggregate = {
      status: failed ? 'failed' : 'completed',
      clubsProcessed: results.reduce((sum, r) => sum + r.clubsProcessed, 0),
      playersUpserted: results.reduce((sum, r) => sum + r.playersUpserted, 0),
      snapshotsWritten: results.reduce((sum, r) => sum + r.snapshotsWritten, 0),
      membershipEvents: results.reduce((sum, r) => sum + r.membershipEvents, 0),
      guildRuns: results.length,
    };
    const audit = await db.from('audit_logs').insert({
      actor_profile_id: guard.session.profile!.id,
      action: 'sync.manual.run',
      target_type: 'sync_run',
      target_id: results.find((r) => r.syncRunId !== '')?.syncRunId ?? null,
      details: aggregate,
    });
    if (audit.error !== null && audit.error !== undefined) {
      console.error('Sync audit logging failed', audit.error.message);
    }
    return redirectWith(failed ? 'failed' : 'success');
  } catch (error) {
    console.error('Manual sync failed', error instanceof Error ? error.message : 'unknown error');
    const audit = await db.from('audit_logs').insert({
      actor_profile_id: guard.session.profile!.id,
      action: 'sync.manual.run',
      target_type: 'sync_run',
      target_id: null,
      details: { status: 'failed' },
    });
    if (audit.error !== null && audit.error !== undefined) {
      console.error('Sync failure audit logging failed', audit.error.message);
    }
    return redirectWith('failed');
  }
}
