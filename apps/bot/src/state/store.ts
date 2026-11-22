import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SupabaseClient } from '@supabase/supabase-js';

const logger = createLogger('bot');

/**
 * Bot-owned persistent state. The service role key is the only switch that
 * enables Supabase; without it every operation uses the in-memory maps below
 * so local tests and single-process development keep working unchanged.
 */

export type StatePayload = Record<string, unknown>;

export interface PersistentSession {
  readonly guildId: string;
  readonly command: string;
  readonly kind: string;
  readonly actorDiscordUserId: string;
  readonly nonce: string;
  readonly payload: StatePayload;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly createdAt: number;
}

export interface SessionKey {
  readonly guildId: string;
  readonly command: string;
  readonly actorDiscordUserId: string;
  readonly nonce: string;
}

export interface CreatePersistentSessionInput extends SessionKey {
  readonly kind: string;
  readonly payload: StatePayload;
  readonly expiresAt: number;
  readonly createdAt?: number;
}

export type SessionTakeResult =
  | { readonly kind: 'ok'; readonly session: PersistentSession }
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'wrong_actor' };

export interface PersistentReplay {
  readonly guildId: string;
  readonly actorDiscordUserId: string;
  readonly nonce: string;
  readonly actionKey: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

export interface ReplayKey {
  readonly guildId: string;
  readonly actorDiscordUserId: string;
  readonly nonce: string;
  readonly actionKey: string;
}

export type VerificationChallengeStatus = 'active' | 'consumed' | 'expired' | 'cancelled';

/** Fields that do not fit the fixed challenge table columns. */
export interface VerificationChallengeDetails {
  readonly profileId: string;
  readonly playerName: string;
  readonly startingIconId: number;
  readonly targetIconId: number;
  readonly targetIconName: string;
  readonly targetIconUrl: string;
}

export interface VerificationChallengeRecord {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly targetPlayerId: string;
  readonly targetTag: string;
  readonly challengeIconId: number | null;
  readonly status: VerificationChallengeStatus;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly details: VerificationChallengeDetails;
}

export interface VerificationChallengeKey {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly targetTag: string;
}

export interface RuntimeLease {
  readonly leaseKind: string;
  readonly scope: string;
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly releasedAt: number | null;
}

export interface RuntimeLeaseIdentity {
  readonly leaseKind: string;
  readonly scope: string;
}

export type LeaseAcquireResult =
  | { readonly kind: 'acquired'; readonly lease: RuntimeLease }
  | { readonly kind: 'held'; readonly lease: RuntimeLease | null };

export class ChallengeConflictError extends Error {
  constructor(message = 'An active verification challenge already exists') {
    super(message);
    this.name = 'ChallengeConflictError';
  }
}

const sessions = new Map<string, PersistentSession>();
const replays = new Map<string, PersistentReplay>();
const challenges = new Map<string, VerificationChallengeRecord>();
const leases = new Map<string, RuntimeLease>();

let trustedClient: SupabaseClient | null | undefined;

const CHALLENGE_DETAILS_COMMAND = 'verification:challenge-details';
const CHALLENGE_DETAILS_KIND = 'verification-challenge-details';

function serviceRoleConfigured(): boolean {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return value !== undefined && value !== '' && !value.startsWith('your-');
}

function getClient(): SupabaseClient | null {
  if (trustedClient !== undefined) return trustedClient;
  if (!serviceRoleConfigured()) {
    trustedClient = null;
    return trustedClient;
  }
  try {
    trustedClient = createTrustedClient();
  } catch (error) {
    logger.warn('Persistent state falling back to memory: trusted client unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    trustedClient = null;
  }
  return trustedClient;
}

/** Fire-and-forget wrapper for write-through calls from synchronous facades. */
export function persistVoid(promise: Promise<unknown>, context: string): void {
  void promise.catch((error: unknown) => {
    logger.warn(`Persistent state write failed: ${context}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
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

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function epoch(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function object(value: unknown): StatePayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as StatePayload)
    : {};
}

function sessionKey(key: SessionKey): string {
  return JSON.stringify([key.guildId, key.command, key.actorDiscordUserId, key.nonce]);
}

function replayKey(key: ReplayKey): string {
  return JSON.stringify([key.guildId, key.actorDiscordUserId, key.nonce, key.actionKey]);
}

function challengeKey(key: VerificationChallengeKey): string {
  return JSON.stringify([key.guildId, key.discordUserId, key.targetTag]);
}

function leaseKey(key: RuntimeLeaseIdentity): string {
  return JSON.stringify([key.leaseKind, key.scope]);
}

interface SessionRow {
  readonly guild_id: string;
  readonly command: string;
  readonly kind: string;
  readonly actor_discord_user_id: string;
  readonly nonce: string;
  readonly payload: unknown;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly created_at: string;
}

function parseSessionRow(value: unknown): PersistentSession | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Partial<SessionRow>;
  if (
    typeof row.guild_id !== 'string' ||
    typeof row.command !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.actor_discord_user_id !== 'string' ||
    typeof row.nonce !== 'string' ||
    typeof row.expires_at !== 'string'
  ) {
    return null;
  }
  return {
    guildId: row.guild_id,
    command: row.command,
    kind: row.kind,
    actorDiscordUserId: row.actor_discord_user_id,
    nonce: row.nonce,
    payload: object(row.payload),
    expiresAt: epoch(row.expires_at),
    consumedAt: typeof row.consumed_at === 'string' ? epoch(row.consumed_at) : null,
    createdAt: epoch(row.created_at),
  };
}

function sessionToRow(session: PersistentSession): Record<string, unknown> {
  return {
    guild_id: session.guildId,
    command: session.command,
    kind: session.kind,
    actor_discord_user_id: session.actorDiscordUserId,
    nonce: session.nonce,
    payload: session.payload,
    expires_at: iso(session.expiresAt),
    ...(session.consumedAt === null ? { consumed_at: null } : { consumed_at: iso(session.consumedAt) }),
    created_at: iso(session.createdAt),
  };
}

/** Create a session. Nonces are generated by callers and are unique per actor/command. */
export async function createPersistentSession(
  input: CreatePersistentSessionInput,
): Promise<PersistentSession> {
  const session: PersistentSession = {
    guildId: input.guildId,
    command: input.command,
    kind: input.kind,
    actorDiscordUserId: input.actorDiscordUserId,
    nonce: input.nonce,
    payload: input.payload,
    expiresAt: input.expiresAt,
    consumedAt: null,
    createdAt: input.createdAt ?? Date.now(),
  };
  const db = getClient();
  if (db === null) {
    sessions.set(sessionKey(session), session);
    return session;
  }

  const { error } = await db.from('guild_interaction_sessions').insert(sessionToRow(session));
  if (isUniqueViolation(error)) {
    // A retried nonce must not overwrite a live session created elsewhere.
    return session;
  }
  requireOk(error, 'Create interaction session');
  sessions.set(sessionKey(session), session);
  return session;
}

/** Read a session without actor/expiry filters so take can explain its refusal. */
async function readSessionForTake(key: SessionKey): Promise<PersistentSession | null> {
  const db = getClient();
  if (db === null) {
    return (
      [...sessions.values()].find(
        (session) =>
          session.guildId === key.guildId &&
          session.command === key.command &&
          session.nonce === key.nonce,
      ) ?? null
    );
  }
  const { data, error } = await db
    .from('guild_interaction_sessions')
    .select('*')
    .eq('guild_id', key.guildId)
    .eq('command', key.command)
    .eq('nonce', key.nonce)
    .maybeSingle();
  requireOk(error, 'Read interaction session for take');
  return parseSessionRow(data);
}

/**
 * Atomically take a single-use session. The delete is guarded by actor,
 * guild, expiry and command, so a racing or wrong-actor click cannot consume
 * someone else's nonce.
 */
export async function takePersistentSession(key: SessionKey): Promise<SessionTakeResult> {
  const existing = await readSessionForTake(key);
  if (existing === null) return { kind: 'missing' };
  if (existing.expiresAt <= Date.now()) {
    await deletePersistentSession(key);
    return { kind: 'expired' };
  }
  if (existing.actorDiscordUserId !== key.actorDiscordUserId) {
    return { kind: 'wrong_actor' };
  }
  if (existing.consumedAt !== null) {
    await deletePersistentSession(key);
    return { kind: 'missing' };
  }

  const db = getClient();
  if (db === null) {
    sessions.delete(sessionKey(key));
    return { kind: 'ok', session: existing };
  }

  const { data, error } = await db
    .from('guild_interaction_sessions')
    .delete()
    .eq('guild_id', key.guildId)
    .eq('command', key.command)
    .eq('actor_discord_user_id', key.actorDiscordUserId)
    .eq('nonce', key.nonce)
    .gt('expires_at', iso(Date.now()))
    .is('consumed_at', null)
    .select()
    .maybeSingle();
  requireOk(error, 'Take interaction session');
  const taken = parseSessionRow(data);
  if (taken === null) return { kind: 'missing' };
  sessions.delete(sessionKey(key));
  return { kind: 'ok', session: taken };
}

/** Non-consuming read used by refreshable sessions and mirror hydration. */
export async function readPersistentSession(key: SessionKey): Promise<PersistentSession | null> {
  const db = getClient();
  if (db === null) {
    const local = sessions.get(sessionKey(key));
    if (local === undefined) return null;
    if (local.expiresAt <= Date.now()) {
      sessions.delete(sessionKey(key));
      return null;
    }
    return local;
  }

  const { data, error } = await db
    .from('guild_interaction_sessions')
    .select('*')
    .eq('guild_id', key.guildId)
    .eq('command', key.command)
    .eq('actor_discord_user_id', key.actorDiscordUserId)
    .eq('nonce', key.nonce)
    .maybeSingle();
  requireOk(error, 'Read interaction session');
  const session = parseSessionRow(data);
  if (session === null) return null;
  if (session.expiresAt <= Date.now()) {
    await deletePersistentSession(key);
    return null;
  }
  return session;
}

export async function updatePersistentSession(
  key: SessionKey,
  update: { readonly payload?: StatePayload; readonly expiresAt?: number },
): Promise<boolean> {
  const current = sessions.get(sessionKey(key));
  const updated: PersistentSession | null =
    current === undefined
      ? null
      : {
          ...current,
          payload: update.payload ?? current.payload,
          expiresAt: update.expiresAt ?? current.expiresAt,
        };

  const db = getClient();
  if (db === null) {
    if (updated !== null) sessions.set(sessionKey(key), updated);
    return updated !== null;
  }

  const patch: Record<string, unknown> = {};
  if (update.payload !== undefined) patch.payload = update.payload;
  if (update.expiresAt !== undefined) patch.expires_at = iso(update.expiresAt);
  if (Object.keys(patch).length === 0) return updated !== null;
  const { data, error } = await db
    .from('guild_interaction_sessions')
    .update(patch)
    .eq('guild_id', key.guildId)
    .eq('command', key.command)
    .eq('actor_discord_user_id', key.actorDiscordUserId)
    .eq('nonce', key.nonce)
    .is('consumed_at', null)
    .select('nonce')
    .maybeSingle();
  requireOk(error, 'Update interaction session');
  if (updated !== null) sessions.set(sessionKey(key), updated);
  return data !== null && typeof data === 'object';
}

export async function deletePersistentSession(key: SessionKey): Promise<boolean> {
  const db = getClient();
  sessions.delete(sessionKey(key));
  if (db === null) return true;
  const { error } = await db
    .from('guild_interaction_sessions')
    .delete()
    .eq('guild_id', key.guildId)
    .eq('command', key.command)
    .eq('actor_discord_user_id', key.actorDiscordUserId)
    .eq('nonce', key.nonce);
  requireOk(error, 'Delete interaction session');
  return true;
}

export async function clearPersistentSessions(command?: string): Promise<void> {
  if (command === undefined) {
    sessions.clear();
  } else {
    for (const [key, session] of sessions) {
      if (session.command === command) sessions.delete(key);
    }
  }
  const db = getClient();
  if (db === null) return;
  let query = db.from('guild_interaction_sessions').delete().neq('command', '');
  if (command !== undefined) query = query.eq('command', command);
  const { error } = await query;
  requireOk(error, 'Clear interaction sessions');
}

export async function listPersistentSessions(
  filter: { readonly command?: string; readonly guildId?: string } = {},
): Promise<PersistentSession[]> {
  const db = getClient();
  if (db === null) {
    return [...sessions.values()].filter(
      (session) =>
        session.expiresAt > Date.now() &&
        (filter.command === undefined || session.command === filter.command) &&
        (filter.guildId === undefined || session.guildId === filter.guildId),
    );
  }

  let query = db.from('guild_interaction_sessions').select('*').gt('expires_at', iso(Date.now()));
  if (filter.command !== undefined) query = query.eq('command', filter.command);
  if (filter.guildId !== undefined) query = query.eq('guild_id', filter.guildId);
  const { data, error } = await query;
  requireOk(error, 'List interaction sessions');
  if (!Array.isArray(data)) return [];
  return data.map(parseSessionRow).filter((row): row is PersistentSession => row !== null);
}

export async function recordPersistentReplay(input: ReplayKey & { readonly expiresAt: number }): Promise<void> {
  const replay: PersistentReplay = {
    guildId: input.guildId,
    actorDiscordUserId: input.actorDiscordUserId,
    nonce: input.nonce,
    actionKey: input.actionKey,
    expiresAt: input.expiresAt,
    createdAt: Date.now(),
  };
  const db = getClient();
  if (db === null) {
    replays.set(replayKey(replay), replay);
    return;
  }
  const { error } = await db.from('guild_interaction_replays').upsert(
    {
      guild_id: replay.guildId,
      actor_discord_user_id: replay.actorDiscordUserId,
      nonce: replay.nonce,
      action_key: replay.actionKey,
      expires_at: iso(replay.expiresAt),
      created_at: iso(replay.createdAt),
    },
    { onConflict: 'guild_id,actor_discord_user_id,nonce,action_key' },
  );
  requireOk(error, 'Record interaction replay');
  replays.set(replayKey(replay), replay);
}

export async function hasPersistentReplay(key: ReplayKey): Promise<boolean> {
  const db = getClient();
  if (db === null) {
    const local = replays.get(replayKey(key));
    if (local === undefined) return false;
    if (local.expiresAt <= Date.now()) {
      replays.delete(replayKey(key));
      return false;
    }
    return true;
  }

  const { data, error } = await db
    .from('guild_interaction_replays')
    .select('expires_at')
    .eq('guild_id', key.guildId)
    .eq('actor_discord_user_id', key.actorDiscordUserId)
    .eq('nonce', key.nonce)
    .eq('action_key', key.actionKey)
    .maybeSingle();
  requireOk(error, 'Read interaction replay');
  if (data === null || typeof data !== 'object') return false;
  const expiresAt = epoch((data as Record<string, unknown>).expires_at);
  return expiresAt > Date.now();
}

export async function listPersistentReplays(): Promise<PersistentReplay[]> {
  const db = getClient();
  if (db === null) {
    return [...replays.values()].filter((replay) => replay.expiresAt > Date.now());
  }
  const { data, error } = await db
    .from('guild_interaction_replays')
    .select('*')
    .gt('expires_at', iso(Date.now()));
  requireOk(error, 'List interaction replays');
  if (!Array.isArray(data)) return [];
  return data.flatMap((value): PersistentReplay[] => {
    if (value === null || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (
      typeof row.guild_id !== 'string' ||
      typeof row.actor_discord_user_id !== 'string' ||
      typeof row.nonce !== 'string' ||
      typeof row.action_key !== 'string' ||
      typeof row.expires_at !== 'string'
    ) {
      return [];
    }
    return [{
      guildId: row.guild_id,
      actorDiscordUserId: row.actor_discord_user_id,
      nonce: row.nonce,
      actionKey: row.action_key,
      expiresAt: epoch(row.expires_at),
      createdAt: epoch(row.created_at),
    }];
  });
}

interface ChallengeRow {
  readonly guild_id: string;
  readonly discord_user_id: string;
  readonly target_player_id: string;
  readonly target_tag: string;
  readonly challenge_icon_id: number | null;
  readonly status: VerificationChallengeStatus;
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function parseChallengeRow(value: unknown, details: VerificationChallengeDetails): VerificationChallengeRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Partial<ChallengeRow>;
  if (
    typeof row.guild_id !== 'string' ||
    typeof row.discord_user_id !== 'string' ||
    typeof row.target_player_id !== 'string' ||
    typeof row.target_tag !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.expires_at !== 'string'
  ) {
    return null;
  }
  const status: VerificationChallengeStatus =
    row.status === 'active' || row.status === 'consumed' || row.status === 'expired' || row.status === 'cancelled'
      ? row.status
      : 'cancelled';
  return {
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    targetPlayerId: row.target_player_id,
    targetTag: row.target_tag,
    challengeIconId: typeof row.challenge_icon_id === 'number' ? row.challenge_icon_id : null,
    status,
    expiresAt: epoch(row.expires_at),
    createdAt: epoch(row.created_at),
    updatedAt: epoch(row.updated_at),
    details,
  };
}

function challengeToRow(record: VerificationChallengeRecord): Record<string, unknown> {
  return {
    guild_id: record.guildId,
    discord_user_id: record.discordUserId,
    target_player_id: record.targetPlayerId,
    target_tag: record.targetTag,
    challenge_icon_id: record.challengeIconId,
    status: record.status,
    expires_at: iso(record.expiresAt),
    created_at: iso(record.createdAt),
    updated_at: iso(record.updatedAt),
  };
}

function defaultDetails(): VerificationChallengeDetails {
  return {
    profileId: '',
    playerName: '',
    startingIconId: 0,
    targetIconId: 0,
    targetIconName: '',
    targetIconUrl: '',
  };
}

async function readChallengeDetails(key: VerificationChallengeKey): Promise<VerificationChallengeDetails> {
  const session = await readPersistentSession({
    guildId: key.guildId,
    command: CHALLENGE_DETAILS_COMMAND,
    actorDiscordUserId: key.discordUserId,
    nonce: key.targetTag,
  });
  const payload = session?.payload;
  if (payload === undefined) return defaultDetails();
  const details = payload.details;
  if (details === null || typeof details !== 'object') return defaultDetails();
  const raw = details as Record<string, unknown>;
  return {
    profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
    playerName: typeof raw.playerName === 'string' ? raw.playerName : '',
    startingIconId: typeof raw.startingIconId === 'number' ? raw.startingIconId : 0,
    targetIconId: typeof raw.targetIconId === 'number' ? raw.targetIconId : 0,
    targetIconName: typeof raw.targetIconName === 'string' ? raw.targetIconName : '',
    targetIconUrl: typeof raw.targetIconUrl === 'string' ? raw.targetIconUrl : '',
  };
}

/**
 * Create the active challenge row plus its detail payload. The details live in
 * the session table because the challenge table intentionally stores only the
 * guild/player/icon identifiers.
 */
export async function createVerificationChallenge(
  record: VerificationChallengeRecord,
): Promise<VerificationChallengeRecord> {
  const db = getClient();
  if (db === null) {
    const existing = [...challenges.values()].find(
      (item) =>
        item.guildId === record.guildId &&
        item.discordUserId === record.discordUserId &&
        item.status === 'active' &&
        item.targetTag !== record.targetTag &&
        item.expiresAt > Date.now(),
    );
    if (existing !== undefined) throw new ChallengeConflictError();
    challenges.set(challengeKey(record), record);
    await createPersistentSession({
      guildId: record.guildId,
      command: CHALLENGE_DETAILS_COMMAND,
      kind: CHALLENGE_DETAILS_KIND,
      actorDiscordUserId: record.discordUserId,
      nonce: record.targetTag,
      payload: { details: record.details as unknown as StatePayload },
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
    return record;
  }

  await createPersistentSession({
    guildId: record.guildId,
    command: CHALLENGE_DETAILS_COMMAND,
    kind: CHALLENGE_DETAILS_KIND,
    actorDiscordUserId: record.discordUserId,
    nonce: record.targetTag,
    payload: { details: record.details as unknown as StatePayload },
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  });

  try {
    const { error } = await db.from('verification_challenges').upsert(challengeToRow(record), {
      onConflict: 'guild_id,discord_user_id,target_tag',
    });
    if (isUniqueViolation(error)) throw new ChallengeConflictError();
    requireOk(error, 'Create verification challenge');
  } catch (error) {
    await deletePersistentSession({
      guildId: record.guildId,
      command: CHALLENGE_DETAILS_COMMAND,
      actorDiscordUserId: record.discordUserId,
      nonce: record.targetTag,
    });
    if (error instanceof ChallengeConflictError) throw error;
    throw error;
  }
  challenges.set(challengeKey(record), record);
  return record;
}

export async function readVerificationChallenge(
  key: { readonly guildId: string; readonly discordUserId: string; readonly targetTag?: string },
): Promise<VerificationChallengeRecord | null> {
  const db = getClient();
  if (db === null) {
    const local = [...challenges.values()].find(
      (item) =>
        item.guildId === key.guildId &&
        item.discordUserId === key.discordUserId &&
        item.status === 'active' &&
        (key.targetTag === undefined || item.targetTag === key.targetTag),
    );
    if (local === undefined) return null;
    if (local.expiresAt <= Date.now()) return local;
    return local;
  }

  let query = db
    .from('verification_challenges')
    .select('*')
    .eq('guild_id', key.guildId)
    .eq('discord_user_id', key.discordUserId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);
  if (key.targetTag !== undefined) query = query.eq('target_tag', key.targetTag);
  const { data, error } = await query.maybeSingle();
  requireOk(error, 'Read verification challenge');
  if (data === null || typeof data !== 'object') return null;
  const row = data as Partial<ChallengeRow>;
  const targetTag = row.target_tag;
  if (typeof targetTag !== 'string') return null;
  const details = await readChallengeDetails({
    guildId: key.guildId,
    discordUserId: key.discordUserId,
    targetTag,
  });
  return parseChallengeRow(data, details);
}

export async function listVerificationChallenges(
  key: { readonly guildId?: string; readonly discordUserId?: string } = {},
): Promise<VerificationChallengeRecord[]> {
  const db = getClient();
  if (db === null) {
    return [...challenges.values()].filter(
      (item) =>
        item.status === 'active' &&
        (key.guildId === undefined || item.guildId === key.guildId) &&
        (key.discordUserId === undefined || item.discordUserId === key.discordUserId),
    );
  }

  let query = db.from('verification_challenges').select('*').eq('status', 'active');
  if (key.guildId !== undefined) query = query.eq('guild_id', key.guildId);
  if (key.discordUserId !== undefined) query = query.eq('discord_user_id', key.discordUserId);
  const { data, error } = await query;
  requireOk(error, 'List verification challenges');
  if (!Array.isArray(data)) return [];
  const results: VerificationChallengeRecord[] = [];
  for (const value of data) {
    const row = value as Partial<ChallengeRow>;
    if (typeof row.target_tag !== 'string') continue;
    const details = await readChallengeDetails({
      guildId: String(row.guild_id),
      discordUserId: String(row.discord_user_id),
      targetTag: row.target_tag,
    });
    const parsed = parseChallengeRow(value, details);
    if (parsed !== null) results.push(parsed);
  }
  return results;
}

async function markVerificationChallenge(
  key: VerificationChallengeKey,
  status: Exclude<VerificationChallengeStatus, 'active'>,
): Promise<boolean> {
  const db = getClient();
  const local = challenges.get(challengeKey(key));
  if (db === null) {
    if (local === undefined || local.status !== 'active') return false;
    challenges.set(challengeKey(key), { ...local, status, updatedAt: Date.now() });
    return true;
  }

  const { data, error } = await db
    .from('verification_challenges')
    .update({ status, updated_at: iso(Date.now()) })
    .eq('guild_id', key.guildId)
    .eq('discord_user_id', key.discordUserId)
    .eq('target_tag', key.targetTag)
    .eq('status', 'active')
    .select('target_tag')
    .maybeSingle();
  requireOk(error, 'Update verification challenge');
  if (local !== undefined) challenges.set(challengeKey(key), { ...local, status, updatedAt: Date.now() });
  return data !== null && typeof data === 'object';
}

export async function consumeVerificationChallenge(key: VerificationChallengeKey): Promise<boolean> {
  return markVerificationChallenge(key, 'consumed');
}

export async function expireVerificationChallenge(key: VerificationChallengeKey): Promise<boolean> {
  return markVerificationChallenge(key, 'expired');
}

export async function cancelVerificationChallenge(key: VerificationChallengeKey): Promise<boolean> {
  return markVerificationChallenge(key, 'cancelled');
}

export async function listVerificationChallengeRecords(): Promise<VerificationChallengeRecord[]> {
  return listVerificationChallenges();
}

interface LeaseRow {
  readonly lease_kind: string;
  readonly scope: string;
  readonly owner_id: string;
  readonly acquired_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
}

function parseLeaseRow(value: unknown): RuntimeLease | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Partial<LeaseRow>;
  if (
    typeof row.lease_kind !== 'string' ||
    typeof row.scope !== 'string' ||
    typeof row.owner_id !== 'string' ||
    typeof row.expires_at !== 'string'
  ) {
    return null;
  }
  return {
    leaseKind: row.lease_kind,
    scope: row.scope,
    ownerId: row.owner_id,
    acquiredAt: epoch(row.acquired_at),
    expiresAt: epoch(row.expires_at),
    releasedAt: typeof row.released_at === 'string' ? epoch(row.released_at) : null,
  };
}

function leaseActive(lease: RuntimeLease | null, now = Date.now()): boolean {
  return lease !== null && lease.releasedAt === null && lease.expiresAt > now;
}

/** Read a lease without changing it (mainly for tests and observability). */
export async function readRuntimeLease(key: RuntimeLeaseIdentity): Promise<RuntimeLease | null> {
  const db = getClient();
  if (db === null) return leases.get(leaseKey(key)) ?? null;
  const { data, error } = await db
    .from('guild_runtime_leases')
    .select('*')
    .eq('lease_kind', key.leaseKind)
    .eq('scope', key.scope)
    .maybeSingle();
  requireOk(error, 'Read runtime lease');
  return parseLeaseRow(data);
}

/**
 * Acquire a cluster-wide runtime lease. Either the row did not exist (insert)
 * or it was released/expired (conditional update), so only one owner wins.
 */
export async function acquireRuntimeLease(input: {
  readonly leaseKind: string;
  readonly scope: string;
  readonly ownerId: string;
  readonly ttlMs: number;
}): Promise<LeaseAcquireResult> {
  const now = Date.now();
  const lease: RuntimeLease = {
    leaseKind: input.leaseKind,
    scope: input.scope,
    ownerId: input.ownerId,
    acquiredAt: now,
    expiresAt: now + input.ttlMs,
    releasedAt: null,
  };
  const db = getClient();
  if (db === null) {
    const existing = leases.get(leaseKey(lease)) ?? null;
    if (leaseActive(existing, now)) return { kind: 'held', lease: existing };
    leases.set(leaseKey(lease), lease);
    return { kind: 'acquired', lease };
  }

  const { data: inserted, error: insertError } = await db
    .from('guild_runtime_leases')
    .insert({
      lease_kind: lease.leaseKind,
      scope: lease.scope,
      owner_id: lease.ownerId,
      acquired_at: iso(lease.acquiredAt),
      expires_at: iso(lease.expiresAt),
      released_at: null,
    })
    .select()
    .maybeSingle();
  if (insertError === null || insertError === undefined) {
    const parsed = parseLeaseRow(inserted) ?? lease;
    leases.set(leaseKey(lease), parsed);
    return { kind: 'acquired', lease: parsed };
  }
  if (!isUniqueViolation(insertError)) requireOk(insertError, 'Acquire runtime lease');

  const existing = await readRuntimeLease(lease);
  if (leaseActive(existing, now)) return { kind: 'held', lease: existing };

  const patch = {
    owner_id: lease.ownerId,
    acquired_at: iso(lease.acquiredAt),
    expires_at: iso(lease.expiresAt),
    released_at: null,
  };
  let query = db
    .from('guild_runtime_leases')
    .update(patch)
    .eq('lease_kind', lease.leaseKind)
    .eq('scope', lease.scope);
  if (existing !== null && existing.releasedAt !== null) {
    // The owner filter is enough here: if another process re-acquired the
    // lease after our read, its owner_id differs and this update affects none.
    query = query.eq('owner_id', existing.ownerId);
  } else if (existing !== null) {
    query = query.eq('owner_id', existing.ownerId).lt('expires_at', iso(now));
  }
  const { data: updated, error: updateError } = await query.select().maybeSingle();
  requireOk(updateError, 'Acquire runtime lease');
  const acquired = parseLeaseRow(updated);
  if (acquired === null) return { kind: 'held', lease: existing };
  leases.set(leaseKey(lease), acquired);
  return { kind: 'acquired', lease: acquired };
}

export async function renewRuntimeLease(
  lease: RuntimeLease,
  ttlMs: number,
): Promise<boolean> {
  const db = getClient();
  const expiresAt = Date.now() + ttlMs;
  const local = leases.get(leaseKey(lease));
  if (db === null) {
    if (local === undefined || local.ownerId !== lease.ownerId || local.releasedAt !== null) return false;
    leases.set(leaseKey(lease), { ...local, expiresAt });
    return true;
  }
  const { data, error } = await db
    .from('guild_runtime_leases')
    .update({ expires_at: iso(expiresAt) })
    .eq('lease_kind', lease.leaseKind)
    .eq('scope', lease.scope)
    .eq('owner_id', lease.ownerId)
    .is('released_at', null)
    .select('owner_id')
    .maybeSingle();
  requireOk(error, 'Renew runtime lease');
  if (local !== undefined && local.ownerId === lease.ownerId) {
    leases.set(leaseKey(lease), { ...local, expiresAt });
  }
  return data !== null && typeof data === 'object';
}

export async function releaseRuntimeLease(lease: RuntimeLease): Promise<boolean> {
  const db = getClient();
  const releasedAt = Date.now();
  const local = leases.get(leaseKey(lease));
  if (db === null) {
    if (local === undefined || local.ownerId !== lease.ownerId || local.releasedAt !== null) return false;
    leases.set(leaseKey(lease), { ...local, releasedAt });
    return true;
  }
  const { data, error } = await db
    .from('guild_runtime_leases')
    .update({ released_at: iso(releasedAt) })
    .eq('lease_kind', lease.leaseKind)
    .eq('scope', lease.scope)
    .eq('owner_id', lease.ownerId)
    .is('released_at', null)
    .select('owner_id')
    .maybeSingle();
  requireOk(error, 'Release runtime lease');
  if (local !== undefined && local.ownerId === lease.ownerId) {
    leases.set(leaseKey(lease), { ...local, releasedAt });
  }
  return data !== null && typeof data === 'object';
}

/** Clear every in-memory mirror and cached trusted client. Tests only. */
export function clearStateCachesForTests(): void {
  sessions.clear();
  replays.clear();
  challenges.clear();
  leases.clear();
  trustedClient = undefined;
}
