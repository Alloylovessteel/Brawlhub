import { createTrustedClient, isSupabaseConfigured } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const logger = createLogger('web/health');

export async function GET() {
  let supabase = false;

  if (isSupabaseConfigured()) {
    try {
      const db = createTrustedClient();
      const { error } = await db.from('clubs').select('id').limit(1);

      if (error) {
        supabase = false;
        logger.error('Supabase health check query failed.');
      } else {
        supabase = true;
      }
    } catch {
      supabase = false;
      logger.error('Supabase health check could not be completed.');
    }
  }

  // Presence checks only. Values are never read into the response.
  const checks = {
    supabase,
    brawlStarsKey: Boolean(process.env.BRAWL_STARS_API_KEY),
    discordConfig: Boolean(process.env.DISCORD_TOKEN),
  };

  const status = Object.values(checks).every(Boolean) ? 'ok' : 'degraded';

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      checks,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
