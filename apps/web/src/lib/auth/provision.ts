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

function grantKey(grant: Pick<RoleGrant, 'scope' | 'clubId'>): string {
  return `${grant.scope}:${grant.clubId ?? ''}`;
}

function isUniqueViolation(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const code = (error as { code?: unknown }).code;
  return code === '23505' || /duplicate key|unique constraint/i.test(String(error));
}

async function readShadowProfile(
  db: ReturnType<typeof createTrustedClient>,
  discordUserId: string,
): Promise<string | null> {
  const result = await db
    .from('profiles')
    .select('id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  if (result.error !== null && result.error !== undefined) {
    throw new Error(`Unable to read Discord profile: ${result.error.message}`);
  }
  const id = (result.data as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function transferShadowGrants(
  db: ReturnType<typeof createTrustedClient>,
  shadowProfileId: string,
  authUserId: string,
): Promise<void> {
  const current = await db
    .from('user_roles')
    .select('scope, club_id, role, source, granted_by')
    .eq('user_id', shadowProfileId);
  if (current.error !== null && current.error !== undefined) {
    throw new Error(`Unable to read shadow role grants: ${current.error.message}`);
  }
  const rows = (current.data ?? []) as Array<{
    scope: RoleGrant['scope'];
    club_id: string | null;
    role: RoleGrant['role'];
    source: 'discord' | 'manual';
    granted_by: string | null;
  }>;
  if (rows.length === 0) return;

  const moved = await db.from('user_roles').upsert(
    rows.map((row) => ({
      user_id: authUserId,
      scope: row.scope,
      club_id: row.club_id,
      role: row.role,
      source: row.source,
      granted_by: row.granted_by,
    })),
    { onConflict: 'user_id,scope,club_id', ignoreDuplicates: true },
  );
  if (moved.error !== null && moved.error !== undefined) {
    throw new Error(`Unable to transfer shadow role grants: ${moved.error.message}`);
  }

  const cleared = await db.from('user_roles').delete().eq('user_id', shadowProfileId);
  if (cleared.error !== null && cleared.error !== undefined) {
    throw new Error(`Unable to clear shadow role grants: ${cleared.error.message}`);
  }
}

/**
 * Provision the local profile for a Discord OAuth login. Bot verification can
 * create a shadow profile for the same Discord id first; that row is renamed
 * rather than deleted so its history survives, and its role grants move to the
 * authenticated profile.
 */
async function provisionProfile(
  db: ReturnType<typeof createTrustedClient>,
  input: { user: User; identity: DiscordIdentity },
): Promise<void> {
  const { user, identity } = input;
  const shadowProfileId = await readShadowProfile(db, identity.id);
  if (shadowProfileId !== null && shadowProfileId !== user.id) {
    const renamed = await db
      .from('profiles')
      .update({ discord_user_id: `shadow:${user.id}` })
      .eq('id', shadowProfileId);
    if (renamed.error !== null && renamed.error !== undefined) {
      throw new Error(`Unable to release shadow Discord identity: ${renamed.error.message}`);
    }
  }

  const profile = await db.from('profiles').upsert(
    {
      id: user.id,
      discord_user_id: identity.id,
      username: identity.username,
      avatar_url: identity.avatarUrl,
    },
    { onConflict: 'id' },
  );
  if (profile.error !== null && profile.error !== undefined) {
    if (!isUniqueViolation(profile.error) || shadowProfileId === null) {
      throw new Error(`Unable to provision profile: ${profile.error.message}`);
    }
    // A concurrent request may have completed the shadow release. Re-read and
    // retry once before surfacing a real collision.
    const remainingShadow = await readShadowProfile(db, identity.id);
    if (remainingShadow === null) throw new Error(`Unable to provision profile: ${profile.error.message}`);
    const released = await db
      .from('profiles')
      .update({ discord_user_id: `shadow:${user.id}:retry` })
      .eq('id', remainingShadow);
    if (released.error !== null && released.error !== undefined) {
      throw new Error(`Unable to release shadow Discord identity: ${released.error.message}`);
    }
    const retry = await db.from('profiles').upsert(
      {
        id: user.id,
        discord_user_id: identity.id,
        username: identity.username,
        avatar_url: identity.avatarUrl,
      },
      { onConflict: 'id' },
    );
    if (retry.error !== null && retry.error !== undefined) {
      throw new Error(`Unable to provision profile: ${retry.error.message}`);
    }
  }

  if (shadowProfileId !== null && shadowProfileId !== user.id) {
    await transferShadowGrants(db, shadowProfileId, user.id);
  }

  const discordUser = await db.from('discord_users').upsert(
    {
      discord_user_id: identity.id,
      profile_id: user.id,
      username: identity.username,
      avatar_url: identity.avatarUrl,
    },
    { onConflict: 'discord_user_id' },
  );
  if (discordUser.error !== null && discordUser.error !== undefined) {
    throw new Error(`Unable to provision Discord user: ${discordUser.error.message}`);
  }
}

/** Reconcile Discord-derived grants without deleting unrelated rows first. */
async function refreshGrants(
  db: ReturnType<typeof createTrustedClient>,
  input: { userId: string; grants: readonly RoleGrant[] },
): Promise<void> {
  const manualResult = await db
    .from('user_roles')
    .select('scope, club_id, role, source, granted_by')
    .eq('user_id', input.userId)
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

  const existingResult = await db
    .from('user_roles')
    .select('scope, club_id')
    .eq('user_id', input.userId);
  if (existingResult.error !== null && existingResult.error !== undefined) {
    throw new Error(`Unable to read stored roles: ${existingResult.error.message}`);
  }
  for (const row of existingResult.data ?? []) {
    const grant = { scope: row.scope as RoleGrant['scope'], clubId: row.club_id as string | null };
    if (merged.has(grantKey(grant))) continue;
    let stale = db.from('user_roles').delete().eq('user_id', input.userId).eq('scope', grant.scope);
    stale = grant.clubId === null ? stale.is('club_id', null) : stale.eq('club_id', grant.clubId);
    const removed = await stale;
    if (removed.error !== null && removed.error !== undefined) {
      throw new Error(`Unable to retire stale roles: ${removed.error.message}`);
    }
  }

  const rows = [...merged.values()].map((grant) => ({
    user_id: input.userId,
    scope: grant.scope,
    club_id: grant.clubId,
    role: grant.role,
    source: grant.source,
    granted_by: grant.grantedBy,
  }));
  if (rows.length > 0) {
    const saved = await db.from('user_roles').upsert(rows, {
      onConflict: 'user_id,scope,club_id',
    });
    if (saved.error !== null && saved.error !== undefined) {
      throw new Error(`Unable to store roles: ${saved.error.message}`);
    }
  }
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

  await provisionProfile(db, { user: input.user, identity });
  await refreshGrants(db, { userId: input.user.id, grants: input.grants });

  return identity;
}
