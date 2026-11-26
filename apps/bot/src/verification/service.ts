import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { BrawlStarsApiError, type BrawlStarsClient } from '@brawlhub/brawl-stars';
import { getSharedBrawlStarsClient } from '../api/gateway.js';
import { brawlTagSchema } from '@brawlhub/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cancelVerificationChallenge,
  clearStateCachesForTests,
  consumeVerificationChallenge,
  createVerificationChallenge,
  expireVerificationChallenge,
  listVerificationChallenges,
  persistVoid,
  readVerificationChallenge,
  type VerificationChallengeRecord,
} from '../state/index.js';
import { pickRandomVerificationIconAsync } from './icons.js';
import type {
  CancelVerificationResult,
  CheckVerificationResult,
  StartVerificationResult,
  VerificationChallenge,
} from './types.js';

// The official API can lag an in-game icon change. Keep the required icon
// stable long enough for players to wait for propagation and retry `check`.
const CHALLENGE_TTL_MS = 30 * 60 * 1000;

/**
 * Synchronous mirror for the legacy `getVerificationChallenge` / `cancel`
 * surface. Supabase remains authoritative for async start/check; the mirror is
 * hydrated lazily and updated on every read so restarts reuse live challenges.
 */
const challenges = new Map<string, VerificationChallenge>();
let mirrorHydrationStarted = false;

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
    // The unique index allows only one active main per profile. Demoting and
    // promoting must happen in one database transaction, otherwise a failed
    // promotion would leave the profile without any main account.
    const result = await db.rpc('set_player_verification_main', {
      p_profile_id: profileId,
      p_player_id: target.playerId,
    });
    requireOk(result.error, 'Set main account');
    if (result.data !== true) return { kind: 'not-found' };
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

/** Page size below PostgREST's max_rows (1000). */
const GUILD_LINK_PAGE_SIZE = 500;

function parseGuildLinkRow(value: unknown): RegisteredLinkView | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const verificationId = asString(row.verification_id);
  const playerId = asString(row.player_id);
  const discordUserId = asString(row.discord_user_id);
  if (verificationId === null || playerId === null || discordUserId === null) return null;
  const parsedTag = brawlTagSchema.safeParse(asString(row.tag) ?? '');
  if (!parsedTag.success) return null;
  return {
    verificationId,
    playerId,
    discordUserId,
    discordUsername: asString(row.username),
    tag: parsedTag.data,
    name: asString(row.name),
    isMain: row.is_main === true,
    method: asString(row.method) ?? 'api_snapshot',
    verifiedAt: asString(row.verified_at),
  };
}

function linkCursorTime(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}

/**
 * List active verification links for players in clubs registered to one guild.
 * Guild scope, open membership eligibility and keyset paging all live in the
 * service-role-only RPC, so a capped REST read cannot hide eligible links.
 */
export async function listGuildVerifiedLinks(
  guildId: string,
  options: { db?: SupabaseClient } = {},
): Promise<RegisteredLinkView[]> {
  if (guildId.trim() === '') return [];
  const db = options.db ?? createTrustedClient();
  const links: RegisteredLinkView[] = [];
  let afterVerifiedAt: string | null = null;
  let afterId: string | null = null;

  for (;;) {
    const result: { data: unknown; error: unknown } = await db.rpc('list_guild_verified_links', {
      p_guild_id: guildId,
      p_limit: GUILD_LINK_PAGE_SIZE,
      p_after_verified_at: afterVerifiedAt,
      p_after_id: afterId,
    });
    requireOk(result.error, 'Read guild verification links');
    const page: unknown[] = Array.isArray(result.data) ? result.data : [];
    for (const value of page) {
      const link = parseGuildLinkRow(value);
      if (link !== null) links.push(link);
    }
    if (page.length < GUILD_LINK_PAGE_SIZE) break;

    const last = page.at(-1);
    const lastRow = last !== undefined && typeof last === 'object'
      ? last as Record<string, unknown>
      : null;
    const nextId = lastRow === null ? null : asString(lastRow.verification_id);
    const nextAt = lastRow === null ? null : asString(lastRow.verified_at);
    if (nextId === null) throw new Error('Read guild verification links: missing keyset');
    if (
      afterId !== null &&
      !(
        linkCursorTime(nextAt) < linkCursorTime(afterVerifiedAt) ||
        (linkCursorTime(nextAt) === linkCursorTime(afterVerifiedAt) && nextId < afterId)
      )
    ) {
      throw new Error('Read guild verification links: non-monotonic keyset');
    }
    afterVerifiedAt = nextAt;
    afterId = nextId;
  }

  return links;
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

  const api = deps?.api ?? getSharedBrawlStarsClient();
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
type DeleteUserDataResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'auth-delete-failed' }
  | { readonly kind: 'db-error'; readonly message: string };

function isMissingAuthUser(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message ?? '')
        : String(error ?? '');
  return /user not found/i.test(message);
}

/** Delete the shadow Auth user before local rows so a failure stays retryable. */
async function deleteAuthUser(db: SupabaseClient, profileId: string): Promise<boolean> {
  const admin = (db as unknown as {
    auth?: { admin?: { deleteUser: (id: string) => Promise<unknown> } };
  }).auth?.admin;
  if (admin === undefined || typeof admin.deleteUser !== 'function') return true;
  try {
    const result = (await admin.deleteUser(profileId)) as { readonly error?: unknown } | null | undefined;
    if (result !== null && typeof result === 'object' && result.error !== null && result.error !== undefined) {
      return isMissingAuthUser(result.error);
    }
    return true;
  } catch (error) {
    return isMissingAuthUser(error);
  }
}

export async function deleteUserDataForDiscordUser(
  discordUserId: string,
  options: { db?: SupabaseClient } = {},
): Promise<DeleteUserDataResult> {
  const trimmed = discordUserId.trim();
  if (!/^\d{17,20}$/.test(trimmed)) return { kind: 'not-found' };
  const db = options.db ?? createTrustedClient();
  const profileId = await resolveProfileId(trimmed, db);
  if (profileId === null) return { kind: 'not-found' };

  // Auth cleanup happens first: if it fails, the profile is still present and a
  // retry can finish the deletion instead of reporting a false success.
  if (!(await deleteAuthUser(db, profileId))) return { kind: 'auth-delete-failed' };

  try {
    const removedDiscord = await db.from('discord_users').delete().eq('discord_user_id', trimmed);
    requireOk(removedDiscord.error, 'Delete Discord identity');
    const removedProfile = await db.from('profiles').delete().eq('id', profileId);
    requireOk(removedProfile.error, 'Delete profile');
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

function normalizeGuildId(guildId: string | null | undefined): string {
  const trimmed = guildId?.trim() ?? '';
  return trimmed === '' ? 'dm' : trimmed;
}

function mirrorKey(guildId: string, discordUserId: string): string {
  return JSON.stringify([guildId, discordUserId]);
}

function ensureChallengeMirrorHydrated(): void {
  if (mirrorHydrationStarted) return;
  mirrorHydrationStarted = true;
  persistVoid(
    listVerificationChallenges()
      .then((records) => {
        for (const record of records) {
          if (record.expiresAt > nowMs()) {
            challenges.set(mirrorKey(record.guildId, record.discordUserId), challengeFromRecord(record));
          }
        }
      })
      .catch(() => undefined),
    'hydrate verification challenges',
  );
}

ensureChallengeMirrorHydrated();

function getChallenge(guildId: string, discordUserId: string): VerificationChallenge | null {
  ensureChallengeMirrorHydrated();
  const key = mirrorKey(guildId, discordUserId);
  const challenge = challenges.get(key);
  if (challenge === undefined) return null;
  if (challenge.expiresAt <= nowMs()) {
    challenges.delete(key);
    return null;
  }
  return challenge;
}

function challengeFromRecord(record: VerificationChallengeRecord): VerificationChallenge {
  return {
    guildId: record.guildId,
    discordUserId: record.discordUserId,
    profileId: record.details.profileId,
    playerTag: record.targetTag,
    playerDbId: record.targetPlayerId,
    playerName: record.details.playerName,
    startingIconId: record.details.startingIconId,
    targetIconId: record.details.targetIconId,
    targetIconName: record.details.targetIconName,
    targetIconUrl: record.details.targetIconUrl,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function recordFromChallenge(
  challenge: VerificationChallenge,
): VerificationChallengeRecord {
  return {
    guildId: challenge.guildId,
    discordUserId: challenge.discordUserId,
    targetPlayerId: challenge.playerDbId,
    targetTag: challenge.playerTag,
    challengeIconId: challenge.startingIconId,
    status: 'active',
    expiresAt: challenge.expiresAt,
    createdAt: challenge.createdAt,
    updatedAt: nowMs(),
    details: {
      profileId: challenge.profileId,
      playerName: challenge.playerName,
      startingIconId: challenge.startingIconId,
      targetIconId: challenge.targetIconId,
      targetIconName: challenge.targetIconName,
      targetIconUrl: challenge.targetIconUrl,
    },
  };
}

type ActiveChallengeLookup =
  | { readonly kind: 'active'; readonly challenge: VerificationChallenge; readonly record: VerificationChallengeRecord }
  | { readonly kind: 'expired'; readonly challenge: VerificationChallenge }
  | { readonly kind: 'none' };

async function findActiveChallenge(
  guildId: string,
  discordUserId: string,
): Promise<ActiveChallengeLookup> {
  const record = await readVerificationChallenge({ guildId, discordUserId });
  if (record === null) {
    challenges.delete(mirrorKey(guildId, discordUserId));
    return { kind: 'none' };
  }
  const challenge = challengeFromRecord(record);
  if (challenge.expiresAt <= nowMs()) {
    challenges.delete(mirrorKey(guildId, discordUserId));
    persistVoid(
      expireVerificationChallenge({
        guildId,
        discordUserId,
        targetTag: challenge.playerTag,
      }),
      'expire verification challenge',
    );
    return { kind: 'expired', challenge };
  }
  challenges.set(mirrorKey(guildId, discordUserId), challenge);
  return { kind: 'active', challenge, record };
}

async function finishChallenge(challenge: VerificationChallenge): Promise<void> {
  challenges.delete(mirrorKey(challenge.guildId, challenge.discordUserId));
  try {
    await consumeVerificationChallenge({
      guildId: challenge.guildId,
      discordUserId: challenge.discordUserId,
      targetTag: challenge.playerTag,
    });
  } catch {
    // The in-process view is already gone; a retry of `check` re-reads Supabase.
  }
}

function formatTag(tag: string): string {
  return `#${tag}`;
}

export async function startVerification(
  input: {
    readonly discordUserId: string;
    readonly tagInput: string;
    readonly discordUsername?: string | null;
    readonly guildId?: string | null;
  },
  deps?: { readonly api?: BrawlStarsClient },
): Promise<StartVerificationResult> {
  const parsed = brawlTagSchema.safeParse(input.tagInput);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-tag', message: invalidTagMessage() };
  }
  const normalizedTag = parsed.data;
  const guildId = normalizeGuildId(input.guildId);

  // Re-running `start` must never rotate the required icon out from under a
  // player who already changed their in-game icon and is waiting on the API.
  const activeLookup = await findActiveChallenge(guildId, input.discordUserId);
  if (activeLookup.kind === 'active') {
    const active = activeLookup.challenge;
    if (active.playerTag === normalizedTag) {
      return { ok: true, challenge: active, reused: true };
    }
    return {
      ok: false,
      code: 'active-challenge',
      message:
        `You already have an active verification challenge for ${formatTag(active.playerTag)} ` +
        `with required icon **${active.targetIconName}**. BrawlHub is checking it automatically; use \`/verify check\` ` +
        `for an immediate status, or \`/verify cancel\` before verifying a different player tag.`,
      challenge: active,
    };
  }

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

  const api = deps?.api ?? getSharedBrawlStarsClient();
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

  const ownedBrawlerIds = new Set<number>();
  const ownedBrawlerNames = new Set<string>();
  for (const brawler of player.brawlers ?? []) {
    if (typeof brawler.id === 'number') ownedBrawlerIds.add(brawler.id);
    const name = asString(brawler.name);
    if (name !== null) ownedBrawlerNames.add(name);
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

  const targetIcon = await pickRandomVerificationIconAsync(iconId, {
    ids: ownedBrawlerIds,
    names: ownedBrawlerNames,
  });
  if (targetIcon === null) {
    return {
      ok: false,
      code: 'icon-unavailable',
      message:
        'None of the brawlers on this account has a default profile icon available for verification. Unlock a brawler or contact staff.',
    };
  }
  const createdAt = nowMs();
  const challenge: VerificationChallenge = {
    guildId,
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
  try {
    await createVerificationChallenge(recordFromChallenge(challenge));
  } catch {
    // A concurrent `start` may have won the one-active-challenge slot. Re-read
    // it so the player sees the existing icon instead of an opaque error.
    const raced = await findActiveChallenge(guildId, input.discordUserId);
    if (raced.kind === 'active') {
      return {
        ok: false,
        code: 'active-challenge',
        message:
          `You already have an active verification challenge for ${formatTag(raced.challenge.playerTag)} ` +
          `with required icon **${raced.challenge.targetIconName}**. BrawlHub is checking it automatically; use \`/verify check\` ` +
          `for an immediate status, or \`/verify cancel\` before verifying a different player tag.`,
        challenge: raced.challenge,
      };
    }
    return {
      ok: false,
      code: 'api-unavailable',
      message: 'BrawlHub could not save your verification challenge right now. Please try again later.',
    };
  }
  challenges.set(mirrorKey(guildId, input.discordUserId), challenge);

  return { ok: true, challenge, reused: false };
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
  input: { readonly discordUserId: string; readonly guildId?: string | null },
  deps?: { readonly api?: BrawlStarsClient },
): Promise<CheckVerificationResult> {
  const guildId = normalizeGuildId(input.guildId);
  const lookup = await findActiveChallenge(guildId, input.discordUserId);
  if (lookup.kind !== 'active') {
    return {
      ok: false,
      code: lookup.kind === 'expired' ? 'expired' : 'no-challenge',
      message: lookup.kind === 'expired'
        ? 'Your verification challenge expired. Run `/verify tag` again to begin a new one.'
        : 'No active verification challenge was found. Run `/verify tag tag:<player-tag>` first.',
    };
  }
  const challenge = lookup.challenge;

  const api = deps?.api ?? getSharedBrawlStarsClient();
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
    if (error instanceof BrawlStarsApiError && error.status === 503) {
      return {
        ok: false,
        code: 'api-unavailable',
        message:
          'The official Brawl Stars API is temporarily unavailable for maintenance. Please try again in a few minutes.',
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
        await finishChallenge(challenge);
        return {
          ok: false,
          code: 'already-verified-self',
          message: `${challenge.playerName} (${formatTag(challenge.playerTag)}) is already verified to your BrawlHub account.`,
        };
      }
      await finishChallenge(challenge);
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
        await finishChallenge(challenge);
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

  await finishChallenge(challenge);
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

export async function cancelVerification(input: {
  readonly discordUserId: string;
  readonly guildId?: string | null;
}): Promise<CancelVerificationResult> {
  const guildId = normalizeGuildId(input.guildId);
  const challenge = getChallenge(guildId, input.discordUserId);
  if (challenge === null) return { ok: true, hadChallenge: false };
  try {
    await cancelVerificationChallenge({
      guildId,
      discordUserId: input.discordUserId,
      targetTag: challenge.playerTag,
    });
  } catch {
    return { ok: false, message: 'Could not cancel verification right now.' };
  }
  challenges.delete(mirrorKey(guildId, input.discordUserId));
  return { ok: true, hadChallenge: true };
}

export function getVerificationChallenge(input: {
  readonly discordUserId: string;
  readonly guildId?: string | null;
}): VerificationChallenge | null {
  return getChallenge(normalizeGuildId(input.guildId), input.discordUserId);
}

export function clearVerificationChallengesForTests(): void {
  challenges.clear();
  clearStateCachesForTests();
  mirrorHydrationStarted = true;
}
