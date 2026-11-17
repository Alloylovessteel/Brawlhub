import { createTrustedClient } from '@brawlhub/database';
import { NextResponse, type NextRequest } from 'next/server';
import {
  getAdminRoleIds,
  getDiscordRoleMap,
  getGuildId,
  getOwnerRoleIds,
  safeNextPath,
} from '@/lib/auth/config';
import { fetchDiscordGuilds, findVerifiedGuild } from '@/lib/auth/discord';
import { extractDiscordIdentity, provisionIdentity } from '@/lib/auth/provision';
import { deriveRoleGrants, type ClubRef } from '@/lib/auth/roles';
import { createServerSupabaseClient } from '@/lib/supabase';

function redirectWithError(request: NextRequest, code: string): NextResponse {
  const url = new URL('/login', request.nextUrl.origin);
  url.searchParams.set('error', code);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNextPath(request.nextUrl.searchParams.get('next'));

  if (request.nextUrl.searchParams.get('error') !== null || code === null) {
    return redirectWithError(request, 'oauth_denied');
  }

  const supabase = await createServerSupabaseClient();
  const exchange = await supabase.auth.exchangeCodeForSession(code);
  if (exchange.error !== null || exchange.data.session === null) {
    return redirectWithError(request, 'oauth_exchange_failed');
  }

  const session = exchange.data.session;
  const providerToken = session.provider_token;
  if (providerToken === null || providerToken === undefined || providerToken.length === 0) {
    await supabase.auth.signOut();
    return redirectWithError(request, 'missing_guild_scope');
  }

  const guildId = getGuildId();
  if (guildId === undefined) {
    await supabase.auth.signOut();
    return redirectWithError(request, 'guild_not_configured');
  }

  try {
    const guilds = await fetchDiscordGuilds(providerToken);
    const guild = findVerifiedGuild(guilds, guildId);
    if (guild === undefined) {
      await supabase.auth.signOut();
      return redirectWithError(request, 'not_server_member');
    }

    const db = createTrustedClient();
    const clubsResult = await db.from('clubs').select('id, tag');
    if (clubsResult.error !== null && clubsResult.error !== undefined) {
      throw new Error('Unable to read registered clubs');
    }
    const clubs = (clubsResult.data ?? []) as ClubRef[];

    const identity = extractDiscordIdentity(session.user);

    const grants = deriveRoleGrants({
      discordUserId: identity.id,
      guild,
      roleMap: getDiscordRoleMap(),
      ownerRoleIds: getOwnerRoleIds(),
      adminRoleIds: getAdminRoleIds(),
      clubs,
    });

    await provisionIdentity({ user: session.user, grants });

    return NextResponse.redirect(new URL(next, request.nextUrl.origin), 303);
  } catch (error) {
    console.error(
      'OAuth callback failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    await supabase.auth.signOut();
    return redirectWithError(request, 'provision_failed');
  }
}
