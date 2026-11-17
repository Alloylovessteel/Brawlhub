import { createHash } from 'node:crypto';
import {
  clubMembersResponseSchema,
  clubSchema,
  createBrawlStarsClient,
  type BrawlStarsClient,
  type Club,
  type ClubMember,
} from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { brawlTagSchema } from '@brawlhub/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const log = createLogger('sync');

/** Fixed scope for the global, all-clubs sync run. */
export const SYNC_SCOPE = 'all-clubs';

/** Default cadence used when SYNC_INTERVAL_MINUTES is absent or invalid. */
export const SYNC_INTERVAL_MINUTES = 15;

const STALE_RUN_MS = 30 * 60 * 1000;
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_NOTIFIER_TIMEOUT_MS = 10_000;
const MEMBERSHIP_EVENT_CONFLICT = 'player_id,event_type,from_club_id,to_club_id,source_sync_run_id';
const MAX_ERROR_LENGTH = 1000;

type EventType = 'join' | 'leave' | 'transfer';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface SyncNotifier {
  send(input: {
    eventId: string;
    eventType: 'join' | 'leave' | 'transfer';
    playerTag: string;
    playerName: string;
    clubName: string;
    fromClubName: string | undefined;
    toClubName: string | undefined;
  }): Promise<string | undefined>;
}

export interface SyncResult {
  syncRunId: string;
  status: 'completed' | 'skipped' | 'failed';
  clubsProcessed: number;
  playersUpserted: number;
  snapshotsWritten: number;
  membershipEvents: number;
  notificationsSent: number;
  error: string | undefined;
  affectedClubIds: string[];
}

/** Input passed to a notifier; also used to derive notification claim metadata. */
export type SyncNotificationInput = Parameters<SyncNotifier['send']>[0];

/**
 * Optional extensions a notifier may implement so the sync can pick a Discord
 * channel to claim. Anything that only implements `send` simply skips claiming,
 * leaving notification delivery to a later phase.
 */
export interface SyncNotifierWithChannel extends SyncNotifier {
  readonly channelId?: string;
  getChannelId?(input: SyncNotificationInput): string | undefined;
}

// ---------------------------------------------------------------------------
// Internal row / state types
// ---------------------------------------------------------------------------

interface ClubRow {
  id: string;
  tag: string;
  name: string;
}

interface RunRow {
  id: string;
  status: string;
  started_at: string;
}

interface IdRow {
  id: string;
}

interface OpenMembershipRow {
  id: string;
  club_id: string;
  player_id: string;
  role: string | null;
}

interface SnapshotHashRow {
  payload_hash: string;
}

interface PlayerLookupRow {
  id: string;
  tag: string;
  name: string;
}

interface ExistingEventRow {
  id: string;
  event_type: string;
  from_club_id: string | null;
  to_club_id: string | null;
}

interface FetchedClub {
  row: ClubRow;
  rawClub: unknown;
  trophies: number;
  memberCount: number;
  members: ClubMember[];
  hash: string;
}

interface RosterEntry {
  tag: string;
  name: string;
  trophies: number;
  role: string;
  clubId: string;
  raw: unknown;
}

interface RosterState extends RosterEntry {
  playerId: string;
}

interface Counters {
  clubsProcessed: number;
  playersUpserted: number;
  snapshotsWritten: number;
  membershipEvents: number;
  notificationsSent: number;
}

interface EventInput {
  playerId: string;
  eventType: EventType;
  fromClubId: string | undefined;
  toClubId: string | undefined;
  detectedAt: string;
  runId: string;
}

interface SnapshotWrite {
  table: 'club_snapshots' | 'player_snapshots';
  entityColumn: 'club_id' | 'player_id';
  entityId: string;
  runId: string;
  hash: string;
  raw: unknown;
  capturedAt: string;
  extra: Record<string, unknown>;
}

type AcquireOutcome =
  | { kind: 'run'; runId: string; affectedColumns: boolean }
  | { kind: 'skip'; result: SyncResult };

// ---------------------------------------------------------------------------
// Shared helpers (also reused by registration.ts)
// ---------------------------------------------------------------------------

/** Produces a single-line, secret-redacted error message safe to persist. */
export function sanitizeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  const redacted = raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(\S+)/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH - 3)}...`
    : redacted;
}

/** Rejects a promise that hangs, so a stalled API call can never be read as an empty roster. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function readPositiveEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function syncIntervalMs(): number {
  const raw = process.env.SYNC_INTERVAL_MINUTES?.trim();
  const minutes = raw === undefined || raw.length === 0 ? SYNC_INTERVAL_MINUTES : Number(raw);
  const safe = Number.isFinite(minutes) ? Math.trunc(minutes) : SYNC_INTERVAL_MINUTES;
  return Math.min(1440, Math.max(1, safe)) * 60_000;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const value: unknown = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === '23505';
}

function isUndefinedColumnError(error: unknown): boolean {
  if (errorCode(error) === '42703' || errorCode(error) === 'PGRST204') {
    return true;
  }
  const message = sanitizeError(error).toLowerCase();
  return (
    message.includes('does not exist') ||
    message.includes('could not find the') ||
    message.includes('undefined column')
  );
}

function requireRow<T>(data: unknown, context: string): T {
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || row === undefined) {
    throw new Error(`${context}: no row returned`);
  }
  return row as T;
}

function requireOk(error: unknown, context: string): void {
  if (error !== null && error !== undefined) {
    throw new Error(`${context}: ${(error as { message?: unknown }).message ?? 'unknown database error'}`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable sha256 of a raw API payload; key order never affects the digest. */
export function payloadHash(payload: unknown): string {
  const canonical = JSON.stringify(canonicalize(payload) ?? null);
  return createHash('sha256').update(canonical).digest('hex');
}

function countersTotal(counters: Counters): number {
  return (
    counters.clubsProcessed +
    counters.playersUpserted +
    counters.snapshotsWritten +
    counters.membershipEvents
  );
}

function emptyCounters(): Counters {
  return {
    clubsProcessed: 0,
    playersUpserted: 0,
    snapshotsWritten: 0,
    membershipEvents: 0,
    notificationsSent: 0,
  };
}

function skippedResult(syncRunId: string, error: string): SyncResult {
  return {
    syncRunId,
    status: 'skipped',
    ...emptyCounters(),
    error,
    affectedClubIds: [],
  };
}

function buildNotification(
  eventId: string,
  eventType: EventType,
  player: { tag: string; name: string },
  clubNames: ReadonlyMap<string, string>,
  fromClubId: string | undefined,
  toClubId: string | undefined,
): SyncNotificationInput {
  const fromName = fromClubId === undefined ? undefined : clubNames.get(fromClubId) ?? '';
  const toName = toClubId === undefined ? undefined : clubNames.get(toClubId) ?? '';
  return {
    eventId,
    eventType,
    playerTag: player.tag,
    playerName: player.name,
    clubName: toName ?? fromName ?? '',
    fromClubName: fromName,
    toClubName: toName,
  };
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function fetchClubData(
  client: BrawlStarsClient,
  row: ClubRow,
  timeoutMs: number,
): Promise<FetchedClub> {
  const rawClub = await withTimeout(client.getClub(row.tag), timeoutMs, `getClub(${row.tag})`);
  const parsedClub = clubSchema.safeParse(rawClub);
  if (!parsedClub.success) {
    throw new Error(`Club ${row.tag} returned malformed data`);
  }
  const club: Club = parsedClub.data;
  const tagCheck = brawlTagSchema.safeParse(club.tag);
  if (!tagCheck.success || tagCheck.data !== row.tag) {
    throw new Error(`Club ${row.tag} returned a mismatched tag (${club.tag})`);
  }

  const rawMembers = await withTimeout(
    client.getClubMembers(row.tag),
    timeoutMs,
    `getClubMembers(${row.tag})`,
  );
  const parsedMembers = clubMembersResponseSchema.safeParse({ items: rawMembers });
  if (!parsedMembers.success) {
    throw new Error(`Club ${row.tag} returned malformed member data`);
  }

  const seen = new Set<string>();
  const members: ClubMember[] = [];
  for (const member of parsedMembers.data.items) {
    const parsedTag = brawlTagSchema.safeParse(member.tag);
    if (!parsedTag.success) {
      throw new Error(`Club ${row.tag} returned a member with an invalid tag`);
    }
    if (seen.has(parsedTag.data)) {
      continue;
    }
    seen.add(parsedTag.data);
    members.push({ ...member, tag: parsedTag.data });
  }

  // The shared Club schema currently strips these API fields; read them
  // defensively so an injected client that supplies them is honoured.
  const rawRecord = rawClub as unknown as Record<string, unknown>;
  const apiMemberCount =
    typeof rawRecord['memberCount'] === 'number' ? rawRecord['memberCount'] : undefined;

  if (
    members.length === 0 &&
    (club.trophies > 0 || (apiMemberCount ?? 0) > 0 || (club.members?.length ?? 0) > 0)
  ) {
    throw new Error(
      `Club ${row.tag} returned an empty member roster while trophies/member count indicate members; aborting sync to avoid corrupting history`,
    );
  }

  return {
    row,
    rawClub,
    trophies: club.trophies,
    memberCount: apiMemberCount ?? members.length,
    members,
    hash: payloadHash(rawClub),
  };
}

function buildGlobalRoster(fetched: readonly FetchedClub[]): Map<string, RosterEntry> {
  const roster = new Map<string, RosterEntry>();
  for (const club of fetched) {
    for (const member of club.members) {
      const existing = roster.get(member.tag);
      if (existing !== undefined) {
        if (existing.clubId !== club.row.id) {
          throw new Error(
            `Player ${member.tag} appears in multiple clubs (${existing.clubId}, ${club.row.id}); aborting sync`,
          );
        }
        continue;
      }
      roster.set(member.tag, {
        tag: member.tag,
        name: member.name,
        trophies: member.trophies,
        role: member.role,
        clubId: club.row.id,
        raw: member,
      });
    }
  }
  return roster;
}

// ---------------------------------------------------------------------------
// Run acquisition / bookkeeping
// ---------------------------------------------------------------------------

function runPayload(
  existingId: string | undefined,
  periodStartIso: string,
  nowIso: string,
  clubIds: readonly string[],
  clubTags: readonly string[],
  affectedColumns: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    scope: SYNC_SCOPE,
    period_start: periodStartIso,
    status: 'running',
    started_at: nowIso,
    finished_at: null,
    error: null,
    records_processed: 0,
  };
  if (existingId !== undefined) {
    payload['id'] = existingId;
  }
  if (affectedColumns) {
    payload['affected_club_ids'] = [...clubIds];
    payload['club_tags'] = [...clubTags];
  }
  return payload;
}

async function upsertRun(
  db: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const result = await db
    .from('sync_runs')
    .upsert(payload, { onConflict: 'scope,period_start' })
    .select('id')
    .single();
  return { data: result.data, error: result.error };
}

async function acquireRun(
  db: SupabaseClient,
  periodStartIso: string,
  nowIso: string,
  nowMs: number,
  clubIds: readonly string[],
  clubTags: readonly string[],
): Promise<AcquireOutcome> {
  const existingResult = await db
    .from('sync_runs')
    .select('id, status, started_at')
    .eq('scope', SYNC_SCOPE)
    .eq('period_start', periodStartIso)
    .maybeSingle();
  requireOk(existingResult.error, 'Read sync_runs');
  const existing = (existingResult.data ?? null) as RunRow | null;

  if (existing?.status === 'completed') {
    return {
      kind: 'skip',
      result: skippedResult(existing.id, 'Sync already completed for this period'),
    };
  }
  if (existing?.status === 'running') {
    const startedMs = Date.parse(existing.started_at);
    if (Number.isFinite(startedMs) && startedMs >= nowMs - STALE_RUN_MS) {
      return {
        kind: 'skip',
        result: skippedResult(existing.id, 'Sync is already running for this period'),
      };
    }
    log.warn('Reusing stale sync run', { syncRunId: existing.id });
  }

  let affectedColumns = true;
  let result = await upsertRun(
    db,
    runPayload(existing?.id, periodStartIso, nowIso, clubIds, clubTags, true),
  );
  if (result.error !== null && result.error !== undefined && isUndefinedColumnError(result.error)) {
    affectedColumns = false;
    result = await upsertRun(
      db,
      runPayload(existing?.id, periodStartIso, nowIso, clubIds, clubTags, false),
    );
  }
  requireOk(result.error, 'Acquire sync run');
  return {
    kind: 'run',
    runId: requireRow<IdRow>(result.data, 'Acquire sync run').id,
    affectedColumns,
  };
}

async function markCompleted(
  db: SupabaseClient,
  runId: string,
  nowIso: string,
  recordsProcessed: number,
  clubIds: readonly string[],
  clubTags: readonly string[],
  affectedColumns: boolean,
): Promise<void> {
  const base: Record<string, unknown> = {
    status: 'completed',
    finished_at: nowIso,
    records_processed: recordsProcessed,
  };
  let patch: Record<string, unknown> = affectedColumns
    ? { ...base, affected_club_ids: [...clubIds], club_tags: [...clubTags] }
    : base;
  let result = await db.from('sync_runs').update(patch).eq('id', runId);
  if (result.error !== null && result.error !== undefined && isUndefinedColumnError(result.error)) {
    patch = base;
    result = await db.from('sync_runs').update(patch).eq('id', runId);
  }
  requireOk(result.error, 'Complete sync run');
}

async function markFailed(
  db: SupabaseClient,
  runId: string,
  message: string,
  nowIso: string,
  recordsProcessed: number,
): Promise<void> {
  await db
    .from('sync_runs')
    .update({
      status: 'failed',
      error: message,
      finished_at: nowIso,
      records_processed: recordsProcessed,
    })
    .eq('id', runId);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function upsertPlayer(
  db: SupabaseClient,
  apiClient: BrawlStarsClient,
  entry: RosterEntry,
  nowIso: string,
  timeoutMs: number,
): Promise<string> {
  const existing = await db.from('players').select('id').eq('tag', entry.tag).maybeSingle();
  requireOk(existing.error, `Read player ${entry.tag}`);

  const extra: Record<string, unknown> = {};
  if (existing.data === null && process.env.SYNC_ENRICH_NEW_PLAYERS === 'true') {
    try {
      const player = await withTimeout(
        apiClient.getPlayer(entry.tag),
        timeoutMs,
        `getPlayer(${entry.tag})`,
      );
      if (typeof player.highscore === 'number') {
        extra['highest_trophies'] = player.highscore;
      }
      if (typeof player.expLevel === 'number') {
        extra['exp_level'] = player.expLevel;
      }
    } catch (error) {
      // Optional enrichment only: never invent stats for a new player.
      log.debug('Player enrichment skipped', { tag: entry.tag, reason: sanitizeError(error) });
    }
  }

  const payload: Record<string, unknown> = {
    tag: entry.tag,
    name: entry.name,
    trophies: entry.trophies,
    last_synced_at: nowIso,
    ...extra,
  };
  const result = await db
    .from('players')
    .upsert(payload, { onConflict: 'tag' })
    .select('id')
    .single();
  requireOk(result.error, `Upsert player ${entry.tag}`);
  return requireRow<IdRow>(result.data, `Upsert player ${entry.tag}`).id;
}

async function readOpenMembership(
  db: SupabaseClient,
  playerId: string,
): Promise<OpenMembershipRow | undefined> {
  const result = await db
    .from('club_memberships')
    .select('id, club_id, player_id, role')
    .eq('player_id', playerId)
    .is('valid_to', null)
    .maybeSingle();
  requireOk(result.error, `Read open membership for ${playerId}`);
  return (result.data ?? undefined) as OpenMembershipRow | undefined;
}

async function readAllOpenMemberships(db: SupabaseClient): Promise<OpenMembershipRow[]> {
  const result = await db
    .from('club_memberships')
    .select('id, club_id, player_id, role')
    .is('valid_to', null);
  requireOk(result.error, 'Read open memberships');
  return (result.data ?? []) as OpenMembershipRow[];
}

async function closeMembership(
  db: SupabaseClient,
  membershipId: string,
  nowIso: string,
): Promise<void> {
  const result = await db
    .from('club_memberships')
    .update({ valid_to: nowIso })
    .eq('id', membershipId);
  requireOk(result.error, `Close membership ${membershipId}`);
}

async function insertMembership(
  db: SupabaseClient,
  state: RosterState,
  nowIso: string,
): Promise<void> {
  const result = await db.from('club_memberships').insert({
    club_id: state.clubId,
    player_id: state.playerId,
    role: state.role,
    valid_from: nowIso,
    valid_to: null,
  });
  requireOk(result.error, `Insert membership for ${state.tag}`);
}

/**
 * Finds an event already claimed by this run. Used after a partial failure so a
 * retry reuses the original classification instead of writing a different event.
 */
async function readEventByPlayerRun(
  db: SupabaseClient,
  playerId: string,
  runId: string,
  eventTypes: readonly EventType[],
): Promise<ExistingEventRow | undefined> {
  const result = await db
    .from('membership_events')
    .select('id, event_type, from_club_id, to_club_id')
    .eq('player_id', playerId)
    .eq('source_sync_run_id', runId)
    .in('event_type', [...eventTypes])
    .order('detected_at', { ascending: false })
    .limit(1);
  requireOk(result.error, `Read existing event for player ${playerId}`);
  return ((result.data ?? []) as ExistingEventRow[])[0];
}

async function recordEvent(db: SupabaseClient, input: EventInput): Promise<string | undefined> {
  const payload: Record<string, unknown> = {
    player_id: input.playerId,
    event_type: input.eventType,
    source_sync_run_id: input.runId,
    detected_at: input.detectedAt,
  };
  if (input.fromClubId !== undefined) {
    payload['from_club_id'] = input.fromClubId;
  }
  if (input.toClubId !== undefined) {
    payload['to_club_id'] = input.toClubId;
  }
  const result = await db
    .from('membership_events')
    .upsert(payload, { onConflict: MEMBERSHIP_EVENT_CONFLICT })
    .select('id')
    .maybeSingle();
  requireOk(result.error, `Record ${input.eventType} event`);
  const row = (result.data ?? null) as IdRow | null;
  return row?.id;
}

async function readPlayerLookup(
  db: SupabaseClient,
  playerId: string,
): Promise<{ tag: string; name: string }> {
  const result = await db
    .from('players')
    .select('id, tag, name')
    .eq('id', playerId)
    .maybeSingle();
  requireOk(result.error, `Read player ${playerId}`);
  const row = (result.data ?? null) as PlayerLookupRow | null;
  return { tag: row?.tag ?? '', name: row?.name ?? '' };
}

async function writeSnapshot(db: SupabaseClient, write: SnapshotWrite): Promise<boolean> {
  const latestResult = await db
    .from(write.table)
    .select('payload_hash')
    .eq(write.entityColumn, write.entityId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  requireOk(latestResult.error, `Read latest ${write.table}`);
  const latest = (latestResult.data ?? null) as SnapshotHashRow | null;
  if (latest?.payload_hash === write.hash) {
    return false;
  }

  const payload: Record<string, unknown> = {
    [write.entityColumn]: write.entityId,
    sync_run_id: write.runId,
    captured_at: write.capturedAt,
    payload_hash: write.hash,
    raw: write.raw,
    ...write.extra,
  };
  const result = await db.from(write.table).upsert(payload, {
    onConflict: `${write.entityColumn},sync_run_id`,
  });
  requireOk(result.error, `Write ${write.table}`);
  return true;
}

async function sendNotifications(
  db: SupabaseClient,
  notifier: SyncNotifier,
  pending: readonly SyncNotificationInput[],
  timeoutMs: number,
): Promise<number> {
  let sent = 0;
  const notifierWithChannel = notifier as SyncNotifierWithChannel;

  for (const input of pending) {
    let channelId: string | undefined;
    if (typeof notifierWithChannel.getChannelId === 'function') {
      channelId = notifierWithChannel.getChannelId(input);
    }
    if (
      channelId === undefined &&
      typeof notifierWithChannel.channelId === 'string' &&
      notifierWithChannel.channelId.length > 0
    ) {
      channelId = notifierWithChannel.channelId;
    }
    // Without a channel there is nothing to claim; Phase 4 can send it later.
    if (channelId === undefined) {
      continue;
    }

    const claim = await db
      .from('notifications')
      .insert({
        event_type: input.eventType,
        event_id: input.eventId,
        channel_id: channelId,
        kind: input.eventType,
      })
      .select('id')
      .maybeSingle();
    if (claim.error !== null && claim.error !== undefined) {
      if (isUniqueViolation(claim.error)) {
        continue; // Already claimed (or already sent) on a previous attempt.
      }
      throw new Error(`Claim notification: ${sanitizeError(claim.error)}`);
    }
    const claimId = ((claim.data ?? null) as IdRow | null)?.id;
    if (claimId === undefined) {
      continue;
    }

    try {
      const messageId = await withTimeout(notifier.send(input), timeoutMs, 'notifier.send');
      if (messageId !== undefined) {
        const update = await db
          .from('notifications')
          .update({ discord_message_id: messageId })
          .eq('id', claimId);
        requireOk(update.error, 'Update notification claim');
      }
      sent += 1;
    } catch (error) {
      // Release the claim so a later run can retry delivery.
      await db.from('notifications').delete().eq('id', claimId);
      log.warn('Notification delivery failed; claim released', {
        eventId: input.eventId,
        reason: sanitizeError(error),
      });
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSync(options?: {
  now?: Date;
  notifier?: SyncNotifier;
  client?: BrawlStarsClient;
}): Promise<SyncResult> {
  let now: Date;
  let nowIso: string;
  let db: SupabaseClient;
  let apiClient: BrawlStarsClient;
  try {
    now = options?.now ?? new Date();
    nowIso = now.toISOString();
    db = createTrustedClient();
    apiClient = options?.client ?? createBrawlStarsClient();
  } catch (error) {
    // Configuration / invalid-input failures must also be reported, never thrown.
    const message = sanitizeError(error);
    log.error('Sync failed during initialisation', { message });
    return {
      syncRunId: '',
      status: 'failed',
      ...emptyCounters(),
      error: message,
      affectedClubIds: [],
    };
  }

  const nowMs = now.getTime();
  const periodStartIso = new Date(Math.floor(nowMs / syncIntervalMs()) * syncIntervalMs()).toISOString();
  const apiTimeoutMs = readPositiveEnv('SYNC_API_TIMEOUT_MS', DEFAULT_API_TIMEOUT_MS);
  const notifierTimeoutMs = readPositiveEnv('SYNC_NOTIFIER_TIMEOUT_MS', DEFAULT_NOTIFIER_TIMEOUT_MS);

  let clubRows: ClubRow[];
  try {
    const clubsResult = await db.from('clubs').select('id, tag, name').order('tag', {
      ascending: true,
    });
    requireOk(clubsResult.error, 'Load registered clubs');
    clubRows = (clubsResult.data ?? []) as ClubRow[];
  } catch (error) {
    const message = sanitizeError(error);
    log.error('Sync failed before acquiring a run', { message });
    return {
      syncRunId: '',
      status: 'failed',
      ...emptyCounters(),
      error: message,
      affectedClubIds: [],
    };
  }

  if (clubRows.length === 0) {
    return skippedResult('', 'No clubs registered');
  }

  const clubIds = clubRows.map((club) => club.id);
  const clubTags = clubRows.map((club) => club.tag);
  const clubNames = new Map(clubRows.map((club) => [club.id, club.name]));

  let runId: string | undefined;
  let affectedColumns = true;
  const counters = emptyCounters();

  try {
    const acquired = await acquireRun(db, periodStartIso, nowIso, nowMs, clubIds, clubTags);
    if (acquired.kind === 'skip') {
      return acquired.result;
    }
    runId = acquired.runId;
    affectedColumns = acquired.affectedColumns;

    // 1. Fetch everything before mutating any temporal state. A single API
    //    failure aborts the whole run; partial rosters are never persisted.
    const fetched: FetchedClub[] = [];
    for (const row of clubRows) {
      fetched.push(await fetchClubData(apiClient, row, apiTimeoutMs));
    }
    counters.clubsProcessed = fetched.length;

    const roster = buildGlobalRoster(fetched);

    // 2. Players.
    const states: RosterState[] = [];
    for (const entry of roster.values()) {
      const playerId = await upsertPlayer(db, apiClient, entry, nowIso, apiTimeoutMs);
      states.push({ ...entry, playerId });
      counters.playersUpserted += 1;
    }
    const presentPlayerIds = new Set(states.map((state) => state.playerId));

    const pendingNotifications: SyncNotificationInput[] = [];

    // 3. Joins and transfers, computed against the global API roster.
    //    The event is written BEFORE membership rows are changed so a partial
    //    failure can be retried without losing or misclassifying the event.
    for (const state of states) {
      const open = await readOpenMembership(db, state.playerId);
      const alreadyCurrent = open !== undefined && open.club_id === state.clubId;
      const existingEvent = await readEventByPlayerRun(db, state.playerId, runId, [
        'join',
        'transfer',
      ]);
      if (alreadyCurrent && existingEvent === undefined) {
        continue;
      }

      const eventType: EventType =
        existingEvent?.event_type === 'join' || existingEvent?.event_type === 'transfer'
          ? existingEvent.event_type
          : open === undefined
            ? 'join'
            : 'transfer';
      const fromClubId = existingEvent
        ? existingEvent.from_club_id ?? undefined
        : open?.club_id;
      const toClubId = existingEvent ? existingEvent.to_club_id ?? undefined : state.clubId;
      const eventId =
        existingEvent?.id ??
        (await recordEvent(db, {
          playerId: state.playerId,
          eventType,
          fromClubId,
          toClubId,
          detectedAt: nowIso,
          runId,
        }));

      if (open !== undefined && open.club_id !== state.clubId) {
        await closeMembership(db, open.id, nowIso);
      }
      if (!alreadyCurrent) {
        await insertMembership(db, state, nowIso);
      }

      if (eventId !== undefined) {
        counters.membershipEvents += 1;
        pendingNotifications.push(
          buildNotification(eventId, eventType, state, clubNames, fromClubId, toClubId),
        );
      }
    }

    // 4. Leaves for open memberships absent from the whole API roster.
    //    Again the event is recorded first so a retry can reuse it.
    const openMemberships = await readAllOpenMemberships(db);
    for (const open of openMemberships) {
      if (presentPlayerIds.has(open.player_id)) {
        continue;
      }
      const player = await readPlayerLookup(db, open.player_id);
      const existingEvent = await readEventByPlayerRun(db, open.player_id, runId, ['leave']);
      const eventId =
        existingEvent?.id ??
        (await recordEvent(db, {
          playerId: open.player_id,
          eventType: 'leave',
          fromClubId: open.club_id,
          toClubId: undefined,
          detectedAt: nowIso,
          runId,
        }));

      await closeMembership(db, open.id, nowIso);

      if (eventId !== undefined) {
        counters.membershipEvents += 1;
        pendingNotifications.push(
          buildNotification(eventId, 'leave', player, clubNames, open.club_id, undefined),
        );
      }
    }

    // 5. Snapshots (skipped when the payload digest is unchanged).
    for (const club of fetched) {
      const written = await writeSnapshot(db, {
        table: 'club_snapshots',
        entityColumn: 'club_id',
        entityId: club.row.id,
        runId,
        hash: club.hash,
        raw: club.rawClub,
        capturedAt: nowIso,
        extra: { trophies: club.trophies, member_count: club.memberCount },
      });
      if (written) {
        counters.snapshotsWritten += 1;
      }
    }
    for (const state of states) {
      const written = await writeSnapshot(db, {
        table: 'player_snapshots',
        entityColumn: 'player_id',
        entityId: state.playerId,
        runId,
        hash: payloadHash(state.raw),
        raw: state.raw,
        capturedAt: nowIso,
        extra: { trophies: state.trophies },
      });
      if (written) {
        counters.snapshotsWritten += 1;
      }
    }

    // 6. Notifications (only when a notifier and a channel are available).
    if (options?.notifier !== undefined) {
      counters.notificationsSent = await sendNotifications(
        db,
        options.notifier,
        pendingNotifications,
        notifierTimeoutMs,
      );
    }

    await markCompleted(
      db,
      runId,
      nowIso,
      countersTotal(counters),
      clubIds,
      clubTags,
      affectedColumns,
    );

    return {
      syncRunId: runId,
      status: 'completed',
      ...counters,
      error: undefined,
      affectedClubIds: clubIds,
    };
  } catch (error) {
    const message = sanitizeError(error);
    log.error('Sync failed', { message, syncRunId: runId ?? '' });
    if (runId !== undefined) {
      try {
        await markFailed(db, runId, message, nowIso, countersTotal(counters));
      } catch (updateError) {
        log.warn('Could not mark sync run as failed', {
          syncRunId: runId,
          reason: sanitizeError(updateError),
        });
      }
    }
    return {
      syncRunId: runId ?? '',
      status: 'failed',
      ...counters,
      error: message,
      affectedClubIds: clubIds,
    };
  }
}
