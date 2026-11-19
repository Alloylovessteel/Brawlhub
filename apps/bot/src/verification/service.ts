import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { BrawlStarsApiError, createBrawlStarsClient, type BrawlStarsClient } from '@brawlhub/brawl-stars';
import { brawlTagSchema } from '@brawlhub/shared';
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

async function resolveProfileId(discordUserId: string): Promise<string | null> {
  const db = createTrustedClient();
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

async function ensureBotProfileForDiscordUser(
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

  const createdAt = nowMs();
  const challenge: VerificationChallenge = {
    discordUserId: input.discordUserId,
    profileId,
    playerTag: normalizedTag,
    playerDbId: playerRow.id,
    playerName: player.name,
    originalIconId: iconId,
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

  if (currentIconId === challenge.originalIconId) {
    return {
      ok: true,
      status: 'unchanged',
      playerTag: challenge.playerTag,
      playerName: challenge.playerName,
      originalIconId: challenge.originalIconId,
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
      fromIconId: challenge.originalIconId,
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
    previousIconId: challenge.originalIconId,
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
