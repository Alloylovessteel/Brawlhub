import { discordIdSchema } from '@brawlhub/shared';
import { createTrustedClient } from '@brawlhub/database';
import type { User } from '@supabase/supabase-js';
import type { RoleGrant } from './roles';

export interface DiscordIdentity {
  id: string;
  username: string | null;
  avatarUrl: string | null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Extracts and validates the Discord identity Supabase stored for this user. */
export function extractDiscordIdentity(user: User): DiscordIdentity {
  const discordIdentity = user.identities?.find((identity) => identity.provider === 'discord');
  const metadata = discordIdentity?.identity_data ?? user.user_metadata ?? {};
  const rawId =
    metadata['provider_id'] ??
    metadata['provider_user_id'] ??
    metadata['sub'] ??
    discordIdentity?.id;

  const parsed = discordIdSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new Error('Discord identity is missing or invalid');
  }

  const username = textOrNull(metadata['username']) ?? textOrNull(metadata['name']);

  return {
    id: parsed.data,
    username,
    avatarUrl: textOrNull(metadata['avatar_url']) ?? textOrNull(metadata['picture']),
  };
}

interface StoredGrant extends RoleGrant {
  source: 'discord' | 'manual';
  grantedBy: string | null;
}

function grantKey(grant: RoleGrant): string {
  return `${grant.scope}:${grant.clubId ?? ''}`;
}

/**
 * Provisions the local profile and refreshes Discord-derived role grants.
 * Manual grants are preserved and take precedence over roles derived from
 * Discord for the same scope/club, avoiding the unique role constraint.
 */
export async function provisionIdentity(input: {
  user: User;
  grants: RoleGrant[];
}): Promise<DiscordIdentity> {
  const db = createTrustedClient();
  const identity = extractDiscordIdentity(input.user);

  const profile = await db.from('profiles').upsert(
    {
      id: input.user.id,
      discord_user_id: identity.id,
      username: identity.username,
      avatar_url: identity.avatarUrl,
    },
    { onConflict: 'id' },
  );
  if (profile.error !== null && profile.error !== undefined) {
    throw new Error(`Unable to provision profile: ${profile.error.message}`);
  }

  const discordUser = await db.from('discord_users').upsert(
    {
      discord_user_id: identity.id,
      profile_id: input.user.id,
      username: identity.username,
      avatar_url: identity.avatarUrl,
    },
    { onConflict: 'discord_user_id' },
  );
  if (discordUser.error !== null && discordUser.error !== undefined) {
    throw new Error(`Unable to provision Discord user: ${discordUser.error.message}`);
  }

  const manualResult = await db
    .from('user_roles')
    .select('scope, club_id, role, granted_by')
    .eq('user_id', input.user.id)
    .eq('source', 'manual');
  if (manualResult.error !== null && manualResult.error !== undefined) {
    throw new Error(`Unable to read existing roles: ${manualResult.error.message}`);
  }
  const manualGrants: StoredGrant[] = (manualResult.data ?? []).map((row) => ({
    scope: row.scope as RoleGrant['scope'],
    clubId: row.club_id as string | null,
    role: row.role as RoleGrant['role'],
    source: 'manual',
    grantedBy: (row.granted_by as string | null) ?? null,
  }));

  const merged = new Map<string, StoredGrant>();
  for (const grant of input.grants) {
    merged.set(grantKey(grant), { ...grant, source: 'discord', grantedBy: null });
  }
  for (const grant of manualGrants) {
    merged.set(grantKey(grant), grant);
  }

  const clearGrants = await db.from('user_roles').delete().eq('user_id', input.user.id);
  if (clearGrants.error !== null && clearGrants.error !== undefined) {
    throw new Error(`Unable to refresh roles: ${clearGrants.error.message}`);
  }

  const rows = [...merged.values()].map((grant) => ({
    user_id: input.user.id,
    scope: grant.scope,
    club_id: grant.clubId,
    role: grant.role,
    source: grant.source,
    ...(grant.grantedBy === null ? {} : { granted_by: grant.grantedBy }),
  }));
  if (rows.length > 0) {
    const insertGrants = await db.from('user_roles').insert(rows);
    if (insertGrants.error !== null && insertGrants.error !== undefined) {
      throw new Error(`Unable to store roles: ${insertGrants.error.message}`);
    }
  }

  return identity;
}
