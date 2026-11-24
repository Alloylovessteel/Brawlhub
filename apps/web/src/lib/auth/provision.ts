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

/**
 * Provision the local profile for a Discord OAuth login.
 *
 * The profile claim, shadow-role transfer and verification handoff are one
 * database transaction. Discord-derived grants are reconciled in a separate
 * transaction that never deletes or overwrites current manual grants.
 */
export async function provisionIdentity(input: {
  user: User;
  grants: RoleGrant[];
}): Promise<DiscordIdentity> {
  const db = createTrustedClient();
  const identity = extractDiscordIdentity(input.user);

  const claimed = await db.rpc('claim_bot_identity', {
    p_auth_user_id: input.user.id,
    p_discord_user_id: identity.id,
    p_username: identity.username,
    p_avatar_url: identity.avatarUrl,
  });
  if (claimed.error !== null && claimed.error !== undefined) {
    throw new Error(`Unable to claim Discord identity: ${claimed.error.message}`);
  }

  const refreshed = await db.rpc('refresh_discord_role_grants', {
    p_profile_id: input.user.id,
    p_grants: input.grants.map((grant) => ({
      scope: grant.scope,
      clubId: grant.clubId,
      role: grant.role,
    })),
  });
  if (refreshed.error !== null && refreshed.error !== undefined) {
    throw new Error(`Unable to refresh Discord role grants: ${refreshed.error.message}`);
  }

  return identity;
}
