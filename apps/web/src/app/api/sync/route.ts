import { timingSafeEqual } from 'node:crypto';
import { runSync } from '@brawlhub/sync';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' };

/** Constant-time string comparison with a length guard before timingSafeEqual. */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Shared handler for both GET and POST so cron schedulers can use either method. */
async function handleSyncRequest(request: Request): Promise<NextResponse> {
  const secret = process.env.SYNC_SECRET?.trim();
  if (secret === undefined || secret === '') {
    return json({ error: 'Sync endpoint is not configured' }, 503);
  }

  const authorization = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const provided = authorization.slice(prefix.length).trim();
  if (!constantTimeEquals(provided, secret)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const result = await runSync();
    return json(result, result.status === 'failed' ? 500 : 200);
  } catch {
    // Never include the secret, request headers, or raw error details in the response.
    return json({ error: 'Sync failed' }, 500);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return handleSyncRequest(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handleSyncRequest(request);
}
