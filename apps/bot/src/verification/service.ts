import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { BrawlStarsApiError, createBrawlStarsClient, type BrawlStarsClient } from '@brawlhub/brawl-stars';
import { brawlTagSchema } from '@brawlhub/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pickRandomVerificationIconAsync } from './icons.js';
import type {
  CancelVerificationResult,
  CheckVerificationResult,
  StartVerificationResult,
  VerificationChallenge,
} from './types.js';

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const challenges = new Map<string, VerificationChallenge>();

function nowMs(): number {
  return Date.now();
}

function invalidTagMessage(): string {
  return 'That player tag is not valid. Brawl Stars tags use 3–10 characters from 0, 2, 8, 9, C, G, J, L, P, Q, R, U, V and Y.';
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === '23505' || (typeof message === 'string' && message.toLowerCase().includes('duplicate'));
}

function requireOk(error: unknown, context: string): void {
  if (error === null || error === undefined) return;
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  throw new Error(`${context}: ${message}`);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function resolveProfileId(
  discordUserId: string,
  db: SupabaseClient = createTrustedClient(),
): Promise<string | null> {
  const { data, error } = await db
    .from('profiles')
    .select('id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  requireOk(error, 'Read profile');
  if (data !== null && typeof data === 'object') {
    const id = asString((data as Record<string, unknown>).id);
    if (id !== null) return id;
  }

  const { data: discordUser, error: discordError } = await db
    .from('discord_users')
    .select('profile_id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  requireOk(discordError, 'Read discord user');
  if (discordUser !== null && typeof discordUser === 'object') {
    const profileId = asString((discordUser as Record<string, unknown>).profile_id);
    if (profileId !== null) {
      const { data: linkedProfile, error: linkedError } = await db
        .from('profiles')
        .select('id')
        .eq('id', profileId)
        .maybeSingle();
      requireOk(linkedError, 'Read linked profile');
      if (linkedProfile !== null && typeof linkedProfile === 'object') {
        const id = asString((linkedProfile as Record<string, unknown>).id);
        if (id !== null) return id;
      }
    }
  }

  return null;
}

export interface VerifiedPlayerIdentity {
  /** Normalized Brawl Stars tag without a leading `#`. */
  readonly tag: string;
  readonly name: string | null;
}

/** One active Discord → Brawl Stars account link, labelled main or alt. */
export interface LinkedAccountView {
  readonly verificationId: string;
  readonly tag: string;
  readonly name: string | null;
  readonly isMain: boolean;
  readonly method: string;
  readonly verifiedAt: string | null;
}

interface ActiveLinkRow {
  readonly verificationId: string;
  readonly playerId: string;
  readonly isMain: boolean;
  readonly method: string;
  readonly verifiedAt: string | null;
  readonly tag: string;
  readonly name: string | null;
}

const LINK_SELECT =
  'id, player_id, is_main, method, verified_at, ' +
  'player:players!player_verifications_player_id_fkey(tag, name)';

function parseLinkRow(value: unknown): ActiveLinkRow | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const verificationId = asString(row.id);
  const playerId = asString(row.player_id);
  const isMain = row.is_main === true;
  const method = asString(row.method) ?? 'api_snapshot';
  const verifiedAt = asString(row.verified_at);
  const player = row.player;
  if (verificationId === null || playerId === null || player === null || typeof player !== 'object') {
    return null;
  }
  const playerRow = player as Record<string, unknown>;
  const parsedTag = brawlTagSchema.safeParse(asString(playerRow.tag) ?? '');
  if (!parsedTag.success) return null;
  return {
    verificationId,
    playerId,
    isMain,
    method,
    verifiedAt,
    tag: parsedTag.data,
    name: asString(playerRow.name),
  };
}

async function readActiveLinks(
  profileId: string,
  db: SupabaseClient,
): Promise<ActiveLinkRow[]> {
  const { data, error } = await db
    .from('player_verifications')
    .select(LINK_SELECT)
    .eq('profile_id', profileId)
    .eq('status', 'active')
    .order('verified_at', { ascending: false });
  requireOk(error, 'Read active verification links');
  if (!Array.isArray(data)) return [];
  return data.map(parseLinkRow).filter((row): row is ActiveLinkRow => row !== null);
}

/** List every active account link for a Discord user, main first. */
export async function listLinkedAccounts(
  discordUserId: string,
  options: { db?: SupabaseClient } = {},
): Promise<LinkedAccountView[] | null> {
  const trimmed = discordUserId.trim();
  if (!/^\d{17,20}$/.test(trimmed)) return null;
  const db = options.db ?? createTrustedClient();
  const profileId = await resolveProfileId(trimmed, db);
  if (profileId === null) return null;
  const links = await readActiveLinks(profileId, db);
  return links
    .sort((a, b) => Number(b.isMain) - Number(a.isMain))
    .map((row) => ({
      verificationId: row.verificationId,
      tag: row.tag,
      name: row.name,
      isMain: row.isMain,
      method: row.method,
      verifiedAt: row.verifiedAt,
    }));
}

export type SetMainResult =
  | { readonly kind: 'ok'; readonly tag: string }
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'db-error'; readonly message: string };

/** Promote one of the caller's active links to main; all others become alts. */
export async function setMainVerification(
  discordUserId: string,
  tagInput: string,
  options: { db?: SupabaseClient } = {},
): Promise<SetMainResult> {
  const parsed = brawlTagSchema.safeParse(tagInput);
  if (!parsed.success) return { kind: 'invalid-tag' };
  const tag = parsed.data;
  const db = options.db ?? createTrustedClient();
  const profileId = await resolveProfileId(discordUserId.trim(), db);
  if (profileId === null) return { kind: 'not-found' };

  const links = await readActiveLinks(profileId, db);
  const target = links.find((link) => link.tag === tag);
  if (target === undefined) return { kind: 'not-found' };
  if (target.isMain && links.filter((link) => link.isMain).length === 1) {
    return { kind: 'ok', tag };
  }

  try {
    const demote = await db
      .from('player_verifications')
      .update({ is_main: false })
      .eq('profile_id', profileId)
      .eq('status', 'active')
      .eq('is_main', true);
    requireOk(demote.error, 'Clear previous main account');
    const promote = await db
      .from('player_verifications')
      .update({ is_main: true })
      .eq('id', target.verificationId)
      .eq('status', 'active');
    requireOk(promote.error, 'Set main account');
    return { kind: 'ok', tag };
  } catch (error) {
    return { kind: 'db-error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve a Discord user to the player they actively verified. The account
 * marked main is preferred; if none is marked (legacy data), the newest active
 * link is used. This never infers ownership from a name or tag match.
 */
export async function findVerifiedPlayerForDiscordUser(
  discordUserId: string,
  options: { db?: SupabaseClient } = {},
): Promise<VerifiedPlayerIdentity | null> {
  const trimmed = discordUserId.trim();
  if (!/^\d{17,20}$/.test(trimmed)) return null;

  const db = options.db ?? createTrustedClient();
  const profileId = await resolveProfileId(trimmed, db);
  if (profileId === null) return null;

  const links = await readActiveLinks(profileId, db);
  const selected =
    links.find((link) => link.isMain) ??
    [...links].sort((a, b) => (b.verifiedAt ?? '').localeCompare(a.verifiedAt ?? ''))[0] ??
    null;
  if (selected === null) return null;
  return { tag: selected.tag, name: selected.name };
}

/** A link as shown to staff, including the owning Discord user and player ID. */
export interface RegisteredLinkView extends LinkedAccountView {
  readonly playerId: string;
  readonly discordUserId: string;
  readonly discordUsername: string | null;
}

const STAFF_LINK_SELECT =
  'id, player_id, is_main, method, verified_at, ' +
  'player:players!player_verifications_player_id_fkey(tag, name), ' +
  'profile:profiles!player_verifications_profile_id_fkey(discord_user_id, username)';

/** Player IDs with an open membership in a club registered to this guild. */
async function readGuildPlayerIds(guildId: string, db: SupabaseClient): Promise<string[]> {
  if (guildId.trim() === '') return [];
  const { data: clubs, error: clubsError } = await db
    .from('clubs')
    .select('id')
    .eq('guild_id', guildId.trim())
    .is('archived_at', null);
  requireOk(clubsError, 'Read guild clubs for link lookup');
  const clubIds = (clubs ?? [])
    .map((row: unknown) =>
      row !== null && typeof row === 'object' ? asString((row as Record<string, unknown>).id) : null,
    )
    .filter((id): id is string => id !== null);
  if (clubIds.length === 0) return [];

  const { data: memberships, error: membershipError } = await db
    .from('club_memberships')
    .select('player_id')
    .in('club_id', clubIds)
    .is('valid_to', null);
  requireOk(membershipError, 'Read guild club memberships for link lookup');
  return (memberships ?? [])
    .map((row: unknown) =>
      row !== null && typeof row === 'object'
        ? asString((row as Record<string, unknown>).player_id)
        : null,
    )
    .filter((id): id is string => id !== null);
}

/** List active verification links for players in clubs registered to one guild. */
export async function listGuildVerifiedLinks(
  guildId: string,
  options: { db?: SupabaseClient } = {},
): Promise<RegisteredLinkView[]> {
  const db = options.db ?? createTrustedClient();
  const playerIds = await readGuildPlayerIds(guildId, db);
  if (playerIds.length === 0) return [];

  const { data, error } = await db
    .from('player_verifications')
    .select(STAFF_LINK_SELECT)
    .eq('status', 'active')
    .in('player_id', playerIds)
    .order('verified_at', { ascending: false });
  requireOk(error, 'Read guild verification links');
  if (!Array.isArray(data)) return [];

  return data.flatMap((value): RegisteredLinkView[] => {
    const link = parseLinkRow(value);
    if (link === null) return [];
    const row = value as unknown as Record<string, unknown>;
    const profile = row.profile;
    if (profile === null || typeof profile !== 'object') return [];
    const profileRow = profile as Record<string, unknown>;
    const discordUserId = asString(profileRow.discord_user_id);
    const playerId = asString(row.player_id);
    if (discordUserId === null || playerId === null) return [];
    return [{
      ...link,
      playerId,
      discordUserId,
      discordUsername: asString(profileRow.username),
    }];
  });
}

export type ManualLinkResult =
  | { readonly kind: 'ok'; readonly account: LinkedAccountView }
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'invalid-user' }
  | { readonly kind: 'player-not-found' }
  | { readonly kind: 'api-unavailable' }
  | { readonly kind: 'already-linked-self' }
  | { readonly kind: 'already-linked-other' }
  | { readonly kind: 'db-error'; readonly message: string };

/**
 * Staff-forced account link. This is an explicit staff action, not an inferred
 * link: it is stored as fully verified with method 'manual_staff' and records
 * the acting staff profile.
 */
export async function linkPlayerManually(
  input: {
    readonly actorProfileId: string;
    readonly actorDiscordUserId: string;
    readonly discordUserId: string;
    readonly tagInput: string;
    readonly reason?: string | null;
  },
  deps?: { readonly api?: BrawlStarsClient },
): Promise<ManualLinkResult> {
  const discordUserId = input.discordUserId.trim();
  if (!/^\d{17,20}$/.test(discordUserId)) return { kind: 'invalid-user' };
  const parsed = brawlTagSchema.safeParse(input.tagInput);
  if (!parsed.success) return { kind: 'invalid-tag' };
  const tag = parsed.data;

  const db = createTrustedClient();
  const profileId = await ensureBotProfileForDiscordUser(discordUserId);
  const links = await readActiveLinks(profileId, db);
  if (links.some((link) => link.tag === tag)) return { kind: 'already-linked-self' };

  const api = deps?.api ?? createBrawlStarsClient();
  let player;
  try {
    player = await api.getPlayer(formatTag(tag));
  } catch (error) {
    if (error instanceof BrawlStarsApiError && error.status === 404) {
      return { kind: 'player-not-found' };
    }
    return { kind: 'api-unavailable' };
  }

  const iconId = asNumber(player.icon?.id);
  let playerRow: PlayerRow;
  try {
    playerRow = await ensurePlayerRecord({
      tag,
      name: player.name,
      trophies: player.trophies,
      highestTrophies: player.highestTrophies ?? player.highscore,
      expLevel: player.expLevel,
      ...(iconId !== null ? { iconId } : {}),
    });
  } catch (error) {
    return { kind: 'db-error', message: error instanceof Error ? error.message : String(error) };
  }

  const { data: existing, error: existingError } = await db
    .from('player_verifications')
    .select('profile_id')
    .eq('player_id', playerRow.id)
    .eq('status', 'active')
    .maybeSingle();
  requireOk(existingError, 'Read existing player link');
  if (existing !== null && typeof existing === 'object') {
    return { kind: 'already-linked-other' };
  }

  const isMain = links.length === 0 || !links.some((link) => link.isMain);
  const evidence = JSON.stringify({
    type: 'manual_staff',
    actorDiscordUserId: input.actorDiscordUserId,
    actorProfileId: input.actorProfileId,
    reason: input.reason ?? null,
    verifiedAt: new Date().toISOString(),
  });
  try {
    const { error } = await db.from('player_verifications').insert({
      profile_id: profileId,
      player_id: playerRow.id,
      status: 'active',
      method: 'manual_staff',
      verified_by_profile_id: input.actorProfileId,
      verified_at: new Date().toISOString(),
      is_main: isMain,
      evidence,
    });
    requireOk(error, 'Insert staff link');
  } catch (error) {
    if (isUniqueViolation(error)) {
      return links.some((link) => link.tag === tag)
        ? { kind: 'already-linked-self' }
        : { kind: 'already-linked-other' };
    }
    return { kind: 'db-error', message: error instanceof Error ? error.message : String(error) };
  }

  return {
    kind: 'ok',
    account: {
      verificationId: '',
      tag,
      name: playerRow.name,
      isMain,
      method: 'manual_staff',
      verifiedAt: new Date().toISOString(),
    },
  };
}

export type RevokeLinkResult =
  | { readonly kind: 'ok'; readonly promoted: boolean }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'db-error'; readonly message: string };

/** Revoke one active link and promote another active link if the main was removed. */
export async function revokeVerification(
  verificationId: string,
  actorProfileId: string,
  options: { db?: SupabaseClient } = {},
): Promise<RevokeLinkResult> {
  const db = options.db ?? createTrustedClient();
  const { data: row, error: readError } = await db
    .from('player_verifications')
    .select('id, profile_id, is_main')
    .eq('id', verificationId)
    .eq('status', 'active')
    .maybeSingle();
  requireOk(readError, 'Read verification to revoke');
  if (row === null || typeof row !== 'object') return { kind: 'not-found' };
  const record = row as Record<string, unknown>;
  const profileId = asString(record.profile_id);
  if (profileId === null) return { kind: 'not-found' };

  try {
    const { error } = await db
      .from('player_verifications')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by_profile_id: actorProfileId,
      })
      .eq('id', verificationId)
      .eq('status', 'active');
    requireOk(error, 'Revoke verification');

    if (record.is_main === true) {
      const remaining = await readActiveLinks(profileId, db);
      const next = [...remaining].sort((a, b) =>
        (a.verifiedAt ?? '').localeCompare(b.verifiedAt ?? ''),
      )[0];
      if (next !== undefined) {
        const promoted = await db
          .from('player_verifications')
          .update({ is_main: true })
          .eq('id', next.verificationId)
          .eq('status', 'active');
        requireOk(promoted.error, 'Promote replacement main account');
        return { kind: 'ok', promoted: true };
      }
    }
    return { kind: 'ok', promoted: false };
  } catch (error) {
    return { kind: 'db-error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Revoke every active link for a Discord user. */
export async function revokeAllLinksForDiscordUser(
  discordUserId: string,
  actorProfileId: string,
  options: { db?: SupabaseClient } = {},
): Promise<{ readonly kind: 'ok'; readonly revoked: number } | { readonly kind: 'not-found' } | { readonly kind: 'db-error'; readonly message: string }> {
  const db = options.db ?? createTrustedClient();
  const profileId = await resolveProfileId(discordUserId.trim(), db);
  if (profileId === null) return { kind: 'not-found' };
  const links = await readActiveLinks(profileId, db);
  let revoked = 0;
  for (const link of links) {
    const result = await revokeVerification(link.verificationId, actorProfileId, { db });
    if (result.kind !== 'ok') return result;
    revoked += 1;
  }
  return { kind: 'ok', revoked };
}

/**
 * Irreversibly erase a Discord user's BrawlHub identity data. Player statistics
 * themselves are not deleted — they are official game data, not user data.
 */
export async function deleteUserDataForDiscordUser(
  discordUserId: string,
  options: { db?: SupabaseClient } = {},
): Promise<{ readonly kind: 'ok' } | { readonly kind: 'not-found' } | { readonly kind: 'db-error'; readonly message: string }> {
  const trimmed = discordUserId.trim();
  if (!/^\d{17,20}$/.test(trimmed)) return { kind: 'not-found' };
  const db = options.db ?? createTrustedClient();
  const profileId = await resolveProfileId(trimmed, db);
  if (profileId === null) return { kind: 'not-found' };

  try {
    const removedDiscord = await db.from('discord_users').delete().eq('discord_user_id', trimmed);
    requireOk(removedDiscord.error, 'Delete Discord identity');
    const removedProfile = await db.from('profiles').delete().eq('id', profileId);
    requireOk(removedProfile.error, 'Delete profile');

    // The shadow auth user is separate from the profile row. Best-effort cleanup:
    // the profile is already gone, so a failed auth delete leaves no usable data.
    const admin = (db as unknown as {
      auth?: { admin?: { deleteUser: (id: string) => Promise<unknown> } };
    }).auth?.admin;
    if (admin !== undefined && typeof admin.deleteUser === 'function') {
      try {
        await admin.deleteUser(profileId);
      } catch {
        // Intentionally ignored: profile and link rows have already been erased.
      }
    }
    return { kind: 'ok' };
  } catch (error) {
    return { kind: 'db-error', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function ensureBotProfileForDiscordUser(
  discordUserId: string,
  discordUsername?: string | null,
): Promise<string> {
  const existing = await resolveProfileId(discordUserId);
  if (existing !== null) return existing;

  const db = createTrustedClient();
  const admin = (db as unknown as { auth?: { admin?: { createUser: (args: unknown) => Promise<any> } } }).auth?.admin;
  if (!admin || typeof admin.createUser !== 'function') {
    throw new Error('Supabase admin API unavailable');
  }

  const email = `discord-${discordUserId}@users.brawlhub.local`;
  const password = `${randomUUID()}${randomUUID()}`;
  const created = await admin.createUser({
    email,
    email_confirm: true,
    password,
    user_metadata: {
      provider: 'discord',
      discord_user_id: discordUserId,
      username: discordUsername ?? null,
      bot_provisioned: true,
    },
  });

  let userId: string | null = asString(created?.data?.user?.id);
  if (userId === null) {
    // If the shadow auth user already exists or another attempt won the race, reuse any resolved profile.
    const raced = await resolveProfileId(discordUserId);
    if (raced !== null) return raced;

    const message = asString(created?.error?.message) ?? 'Failed to create auth user';
    throw new Error(message);
  }

  const username = discordUsername ?? null;
  const { error: profileError } = await db.from('profiles').upsert(
    { id: userId, discord_user_id: discordUserId, username },
    { onConflict: 'id' },
  );
  if (profileError) {
    if (isUniqueViolation(profileError)) {
      const raced = await resolveProfileId(discordUserId);
      if (raced !== null) return raced;
    }
    requireOk(profileError, 'Provision profile');
  }

  const { error: discordError } = await db.from('discord_users').upsert(
    { discord_user_id: discordUserId, profile_id: userId, username },
    { onConflict: 'discord_user_id' },
  );
  if (discordError) {
    if (isUniqueViolation(discordError)) {
      const raced = await resolveProfileId(discordUserId);
      if (raced !== null) return raced;
    }
    requireOk(discordError, 'Provision discord user');
  }

  return userId;
}

interface PlayerRow {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
}

async function ensurePlayerRecord(input: {
  readonly tag: string;
  readonly name: string;
  readonly trophies: number;
  readonly highestTrophies?: number | undefined;
  readonly expLevel?: number | undefined;
  readonly iconId?: number | undefined;
}): Promise<PlayerRow> {
  const db = createTrustedClient();
  const { data: existing, error: readError } = await db
    .from('players')
    .select('id, tag, name')
    .eq('tag', input.tag)
    .maybeSingle();
  requireOk(readError, 'Read player');

  if (existing !== null && typeof existing === 'object') {
    const row = existing as Record<string, unknown>;
    const id = asString(row.id);
    const tag = asString(row.tag);
    const name = asString(row.name);
    if (id !== null && tag !== null && name !== null) {
      // Keep basic identity fresh when we have a live API read.
      await db
        .from('players')
        .update({
          name: input.name,
          trophies: input.trophies,
          ...(input.highestTrophies !== undefined ? { highest_trophies: input.highestTrophies } : {}),
          ...(input.expLevel !== undefined ? { exp_level: input.expLevel } : {}),
          ...(input.iconId !== undefined ? { icon_id: input.iconId } : {}),
        })
        .eq('id', id);
      return { id, tag, name: input.name };
    }
  }

  const { data: inserted, error: insertError } = await db
    .from('players')
    .upsert(
      {
        tag: input.tag,
        name: input.name,
        trophies: input.trophies,
        ...(input.highestTrophies !== undefined ? { highest_trophies: input.highestTrophies } : {}),
        ...(input.expLevel !== undefined ? { exp_level: input.expLevel } : {}),
        ...(input.iconId !== undefined ? { icon_id: input.iconId } : {}),
      },
      { onConflict: 'tag' },
    )
    .select('id, tag, name')
    .single();
  requireOk(insertError, 'Upsert player');
  if (inserted === null || typeof inserted !== 'object') {
    throw new Error('Upsert player: missing row');
  }
  const row = inserted as Record<string, unknown>;
  const id = asString(row.id);
  const tag = asString(row.tag);
  const name = asString(row.name);
  if (id === null || tag === null || name === null) {
    throw new Error('Upsert player: invalid row');
  }
  return { id, tag, name };
}

function getChallenge(discordUserId: string): VerificationChallenge | null {
  const challenge = challenges.get(discordUserId);
  if (challenge === undefined) return null;
  if (challenge.expiresAt <= nowMs()) {
    challenges.delete(discordUserId);
    return null;
  }
  return challenge;
}

function formatTag(tag: string): string {
  return `#${tag}`;
}

export async function startVerification(
  input: {
    readonly discordUserId: string;
    readonly tagInput: string;
    readonly discordUsername?: string | null;
  },
  deps?: { readonly api?: BrawlStarsClient },
): Promise<StartVerificationResult> {
  const parsed = brawlTagSchema.safeParse(input.tagInput);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-tag', message: invalidTagMessage() };
  }
  const normalizedTag = parsed.data;

  let profileId: string;
  try {
    profileId = await ensureBotProfileForDiscordUser(input.discordUserId, input.discordUsername);
  } catch {
    return {
      ok: false,
      code: 'api-unavailable',
      message: 'BrawlHub could not prepare your Discord account for verification right now. Please try again later.',
    };
  }

  const api = deps?.api ?? createBrawlStarsClient();
  let player;
  try {
    player = await api.getPlayer(formatTag(normalizedTag));
  } catch (error) {
    if (error instanceof BrawlStarsApiError && error.status === 404) {
      return {
        ok: false,
        code: 'player-not-found',
        message: `No Brawl Stars player was found for ${formatTag(normalizedTag)} in the official API.`,
      };
    }
    return {
      ok: false,
      code: 'api-unavailable',
      message: 'The official Brawl Stars API could not be reached right now. Please try again later.',
    };
  }

  const iconId = asNumber(player.icon?.id);
  if (iconId === null) {
    return {
      ok: false,
      code: 'icon-unavailable',
      message: 'The official API did not return a player icon for that account, so icon verification cannot be started.',
    };
  }

  let playerRow: PlayerRow;
  try {
    playerRow = await ensurePlayerRecord({
      tag: normalizedTag,
      name: player.name,
      trophies: player.trophies,
      highestTrophies: player.highestTrophies ?? player.highscore,
      expLevel: player.expLevel,
      iconId,
    });
  } catch {
    return {
      ok: false,
      code: 'api-unavailable',
      message: 'BrawlHub could not prepare that player record right now. Please try again later.',
    };
  }

  const targetIcon = await pickRandomVerificationIconAsync(iconId);
  const createdAt = nowMs();
  const challenge: VerificationChallenge = {
    discordUserId: input.discordUserId,
    profileId,
    playerTag: normalizedTag,
    playerDbId: playerRow.id,
    playerName: player.name,
    startingIconId: iconId,
    targetIconId: targetIcon.id,
    targetIconName: targetIcon.name,
    targetIconUrl: targetIcon.imageUrl,
    createdAt,
    expiresAt: createdAt + CHALLENGE_TTL_MS,
  };
  challenges.set(input.discordUserId, challenge);

  return { ok: true, challenge };
}

async function findActiveVerificationForPlayer(playerDbId: string): Promise<{ profileId: string } | null> {
  const db = createTrustedClient();
  const { data, error } = await db
    .from('player_verifications')
    .select('profile_id')
    .eq('player_id', playerDbId)
    .eq('status', 'active')
    .maybeSingle();
  requireOk(error, 'Read player verification');
  if (data === null || typeof data !== 'object') return null;
  const profileId = asString((data as Record<string, unknown>).profile_id);
  return profileId === null ? null : { profileId };
}

export async function checkVerification(
  input: { readonly discordUserId: string },
  deps?: { readonly api?: BrawlStarsClient },
): Promise<CheckVerificationResult> {
  const challenge = getChallenge(input.discordUserId);
  if (challenge === null) {
    const expired = challenges.has(input.discordUserId);
    if (expired) challenges.delete(input.discordUserId);
    return {
      ok: false,
      code: expired ? 'expired' : 'no-challenge',
      message: expired
        ? 'Your verification challenge expired. Run `/member-verify start` again to begin a new one.'
        : 'No active verification challenge was found. Run `/member-verify start tag:<player-tag>` first.',
    };
  }

  const api = deps?.api ?? createBrawlStarsClient();
  let player;
  try {
    player = await api.getPlayer(formatTag(challenge.playerTag));
  } catch (error) {
    if (error instanceof BrawlStarsApiError && error.status === 404) {
      return {
        ok: false,
        code: 'player-not-found',
        message: `Player ${formatTag(challenge.playerTag)} could not be found in the official API right now.`,
      };
    }
    return {
      ok: false,
      code: 'api-unavailable',
      message: 'The official Brawl Stars API could not be reached right now. Please try again later.',
    };
  }

  const currentIconId = asNumber(player.icon?.id);
  if (currentIconId === null) {
    return {
      ok: false,
      code: 'api-unavailable',
      message: 'The official API did not return a current player icon. Please try again in a moment.',
    };
  }

  if (currentIconId !== challenge.targetIconId) {
    return {
      ok: true,
      status: 'pending',
      playerTag: challenge.playerTag,
      playerName: challenge.playerName,
      startingIconId: challenge.startingIconId,
      targetIconId: challenge.targetIconId,
      targetIconName: challenge.targetIconName,
      targetIconUrl: challenge.targetIconUrl,
      currentIconId,
      expiresAt: challenge.expiresAt,
    };
  }

  try {
    const active = await findActiveVerificationForPlayer(challenge.playerDbId);
    if (active !== null) {
      if (active.profileId === challenge.profileId) {
        challenges.delete(input.discordUserId);
        return {
          ok: false,
          code: 'already-verified-self',
          message: `${challenge.playerName} (${formatTag(challenge.playerTag)}) is already verified to your BrawlHub account.`,
        };
      }
      challenges.delete(input.discordUserId);
      return {
        ok: false,
        code: 'already-verified-other',
        message: `${challenge.playerName} (${formatTag(challenge.playerTag)}) is already verified to a different BrawlHub account. If this is your account, contact staff for help.`,
      };
    }

    const db = createTrustedClient();
    const evidence = JSON.stringify({
      type: 'discord_icon_challenge',
      discordUserId: input.discordUserId,
      playerTag: formatTag(challenge.playerTag),
      fromIconId: challenge.startingIconId,
      targetIconId: challenge.targetIconId,
      targetIconName: challenge.targetIconName,
      toIconId: currentIconId,
      verifiedAt: new Date().toISOString(),
    });
    const { error } = await db.from('player_verifications').insert({
      profile_id: challenge.profileId,
      player_id: challenge.playerDbId,
      status: 'active',
      method: 'api_snapshot',
      evidence,
    });
    if (error) {
      if (isUniqueViolation(error)) {
        const existing = await findActiveVerificationForPlayer(challenge.playerDbId);
        challenges.delete(input.discordUserId);
        if (existing?.profileId === challenge.profileId) {
          return {
            ok: false,
            code: 'already-verified-self',
            message: `${challenge.playerName} (${formatTag(challenge.playerTag)}) is already verified to your BrawlHub account.`,
          };
        }
        return {
          ok: false,
          code: 'already-verified-other',
          message: `${challenge.playerName} (${formatTag(challenge.playerTag)}) is already verified to a different BrawlHub account. If this is your account, contact staff for help.`,
        };
      }
      return {
        ok: false,
        code: 'db-error',
        message: 'Verification could not be saved right now. Please try again later.',
      };
    }
  } catch {
    return {
      ok: false,
      code: 'db-error',
      message: 'Verification could not be saved right now. Please try again later.',
    };
  }

  challenges.delete(input.discordUserId);
  return {
    ok: true,
    status: 'verified',
    playerTag: challenge.playerTag,
    playerName: challenge.playerName,
    startingIconId: challenge.startingIconId,
    targetIconId: challenge.targetIconId,
    targetIconName: challenge.targetIconName,
    targetIconUrl: challenge.targetIconUrl,
    currentIconId,
  };
}

export function cancelVerification(input: { readonly discordUserId: string }): CancelVerificationResult {
  const hadChallenge = challenges.delete(input.discordUserId);
  return { ok: true, hadChallenge };
}

export function getVerificationChallenge(input: {
  readonly discordUserId: string;
}): VerificationChallenge | null {
  return getChallenge(input.discordUserId);
}

export function clearVerificationChallengesForTests(): void {
  challenges.clear();
}
