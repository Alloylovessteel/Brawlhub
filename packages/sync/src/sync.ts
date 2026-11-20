import { createHash, randomUUID } from 'node:crypto';
import {
  battleLogResponseSchema,
  clubMembersResponseSchema,
  clubSchema,
  createBrawlStarsClient,
  type BattleLogItem,
  type BrawlStarsClient,
  type Club,
  type ClubMember,
  type Player,
} from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { brawlTagSchema } from '@brawlhub/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const log = createLogger('sync');

/** Fixed scope for legacy global sync runs. Prefer {@link guildSyncScope}. */
export const SYNC_SCOPE = 'all-clubs';

/** Database/sync-run scope for one Discord guild's registered clubs. */
export function guildSyncScope(guildId: string): string {
  const normalized = guildId.trim();
  if (normalized.length === 0) {
    throw new Error('A Discord guild id is required for scoped sync');
  }
  return `guild:${normalized}`;
}

/** Default cadence used when SYNC_INTERVAL_MINUTES is absent or invalid. */
export const SYNC_INTERVAL_MINUTES = 15;

const STALE_RUN_MS = 30 * 60 * 1000;
const SYNC_LOCK_TTL_SECONDS = 30 * 60;
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_NOTIFIER_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 1000;

type EventType = 'join' | 'leave' | 'transfer';

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseBattleTime(value: string): string | null {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/);
  if (!compact) return null;
  const [, y, m, d, hh, mm, ss, ms] = compact;
  const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms ?? '000'}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function battleKey(item: BattleLogItem): string {
  const parts = [
    item.battleTime,
    item.event?.id ?? '',
    item.event?.mode ?? '',
    item.event?.map ?? '',
    item.battle?.mode ?? '',
    item.battle?.type ?? '',
    item.battle?.result ?? '',
    item.battle?.duration ?? '',
    item.battle?.trophyChange ?? '',
    item.battle?.rank ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

async function collectBattleLogs(
  db: SupabaseClient,
  client: BrawlStarsClient,
  states: ReadonlyArray<{ playerId: string; tag: string }>,
  syncRunId: string,
  timeoutMs: number,
): Promise<number> {
  const byPlayer = new Map<string, string>();
  for (const state of states) byPlayer.set(state.playerId, state.tag);
  let inserted = 0;

  for (const [playerId, tag] of byPlayer) {
    let items: BattleLogItem[];
    try {
      items = await withTimeout(client.getBattleLog(tag), timeoutMs, `Battle log for ${tag}`);
    } catch (error) {
      log.warn('Battle log fetch failed', {
        tag,
        syncRunId,
        reason: sanitizeError(error),
      });
      continue;
    }

    const rows = items
      .map((item) => {
        const battleTime = parseBattleTime(item.battleTime);
        if (battleTime === null) return null;
        return {
          player_id: playerId,
          sync_run_id: syncRunId,
          battle_time: battleTime,
          battle_key: battleKey(item),
          mode: item.event?.mode ?? item.battle?.mode ?? null,
          map: item.event?.map ?? null,
          battle_type: item.battle?.type ?? null,
          result: item.battle?.result ?? null,
          trophy_change:
            typeof item.battle?.trophyChange === 'number' && Number.isFinite(item.battle.trophyChange)
              ? item.battle.trophyChange
              : null,
          raw: item as unknown as Record<string, unknown>,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) continue;

    const { error } = await db
      .from('player_battles')
      .upsert(rows, { onConflict: 'player_id,battle_key', ignoreDuplicates: true });
    if (error) {
      log.warn('Battle log write failed', {
        tag,
        syncRunId,
        reason: error.message,
      });
      continue;
    }
    inserted += rows.length;

    const latest = rows.reduce<string | null>((max, row) => {
      if (max === null) return row.battle_time;
      return row.battle_time > max ? row.battle_time : max;
    }, null);
    if (latest !== null) {
      const { data: current } = await db
        .from('players')
        .select('last_battle_at')
        .eq('id', playerId)
        .maybeSingle();
      const currentValue = typeof current?.last_battle_at === 'string' ? current.last_battle_at : null;
      if (currentValue === null || latest > currentValue) {
        const { error: updateError } = await db
          .from('players')
          .update({ last_battle_at: latest })
          .eq('id', playerId);
        if (updateError) {
          log.warn('Could not update player last_battle_at', {
            tag,
            syncRunId,
            reason: updateError.message,
          });
        }
      }
    }
  }

  return inserted;
}

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
  guild_id?: string | null;
}

interface RunRow {
  id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string | null;
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

interface RunEventRow {
  id: string;
  player_id: string;
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
  battlesCollected: number;
}

interface EventInput {
  playerId: string;
  eventType: EventType;
  fromClubId: string | undefined;
  toClubId: string | undefined;
  detectedAt: string;
  runId: string;
}

interface MembershipTransitionInput extends EventInput {
  role: string | undefined;
  validFrom: string;
  closeMembershipId: string | undefined;
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
    battlesCollected: 0,
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
  scope: string,
  periodStartIso: string,
  nowIso: string,
  clubIds: readonly string[],
  clubTags: readonly string[],
  affectedColumns: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    scope,
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
  scope: string,
  periodStartIso: string,
  nowIso: string,
  nowMs: number,
  clubIds: readonly string[],
  clubTags: readonly string[],
): Promise<AcquireOutcome> {
  const existingResult = await db
    .from('sync_runs')
    .select('id, status, started_at')
    .eq('scope', scope)
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
    const startedMs = existing.started_at ? Date.parse(existing.started_at) : Number.NaN;
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
    runPayload(existing?.id, scope, periodStartIso, nowIso, clubIds, clubTags, true),
  );
  if (result.error !== null && result.error !== undefined && isUndefinedColumnError(result.error)) {
    affectedColumns = false;
    result = await upsertRun(
      db,
      runPayload(existing?.id, scope, periodStartIso, nowIso, clubIds, clubTags, false),
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
      last_error: message,
      finished_at: nowIso,
      records_processed: recordsProcessed,
    })
    .eq('id', runId);
}

// ---------------------------------------------------------------------------
// Database-level lock and atomic membership transitions
// ---------------------------------------------------------------------------

/** Claims the sync lock for a scope. Only one process can hold it at a time. */
async function acquireSyncLock(
  db: SupabaseClient,
  scope: string,
  token: string,
): Promise<boolean> {
  const result = await db.rpc('try_acquire_sync_lock', {
    p_scope: scope,
    p_token: token,
    p_ttl_seconds: SYNC_LOCK_TTL_SECONDS,
  });
  requireOk(result.error, 'Acquire sync lock');
  return result.data === token;
}

async function releaseSyncLock(
  db: SupabaseClient,
  scope: string,
  token: string,
): Promise<void> {
  const result = await db.rpc('release_sync_lock', {
    p_scope: scope,
    p_token: token,
  });
  if (result.error !== null && result.error !== undefined) {
    log.warn('Could not release sync lock', { reason: sanitizeError(result.error), scope });
  }
}

export interface SyncRecoveryResult {
  readonly recoveredRuns: number;
  readonly clearedScopes: string[];
}

/**
 * Clear run rows and lock claims left behind when a process exits mid-sync.
 * Called once on bot startup so a restart never blocks syncing until the
 * 30-minute lock TTL expires. Safe to call repeatedly: it only touches rows
 * that are still marked `running` with no `finished_at`.
 */
export async function recoverInterruptedSyncs(
  db: SupabaseClient = createTrustedClient(),
  nowIso: string = new Date().toISOString(),
): Promise<SyncRecoveryResult> {
  const running = await db
    .from('sync_runs')
    .select('id, scope')
    .eq('status', 'running')
    .is('finished_at', null);
  requireOk(running.error, 'Read interrupted sync runs');

  const rows = (running.data ?? []) as Array<{ id: string; scope: string | null }>;
  if (rows.length === 0) {
    return { recoveredRuns: 0, clearedScopes: [] };
  }

  const reason = 'Sync interrupted by process restart';
  const finished = await db
    .from('sync_runs')
    .update({ status: 'failed', error: reason, last_error: reason, finished_at: nowIso })
    .in(
      'id',
      rows.map((row) => row.id),
    );
  requireOk(finished.error, 'Mark interrupted sync runs failed');

  const scopes = [
    ...new Set(
      rows
        .map((row) => row.scope)
        .filter((scope): scope is string => typeof scope === 'string' && scope.trim() !== ''),
    ),
  ];
  if (scopes.length > 0) {
    const cleared = await db
      .from('sync_locks')
      .update({ locked_by: null, locked_at: null, locked_until: null })
      .in('scope', scopes);
    requireOk(cleared.error, 'Clear interrupted sync locks');
  }

  log.warn('Recovered interrupted sync state', {
    runs: rows.length,
    scopes: scopes.join(', '),
  });
  return { recoveredRuns: rows.length, clearedScopes: scopes };
}

/** Writes event + membership changes in one Postgres transaction. */
async function applyMembershipTransition(
  db: SupabaseClient,
  input: MembershipTransitionInput,
): Promise<string | undefined> {
  const result = await db.rpc('apply_membership_transition', {
    p_player_id: input.playerId,
    p_event_type: input.eventType,
    p_from_club_id: input.fromClubId ?? null,
    p_to_club_id: input.toClubId ?? null,
    p_detected_at: input.detectedAt,
    p_run_id: input.runId,
    p_role: input.role ?? null,
    p_valid_from: input.validFrom,
    p_close_membership_id: input.closeMembershipId ?? null,
  });
  requireOk(result.error, `Apply ${input.eventType} transition`);
  return typeof result.data === 'string' ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function playerProfilePayload(player: Player): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    name: player.name,
    trophies: player.trophies,
  };

  const highest = player.highestTrophies ?? player.highscore;
  if (typeof highest === 'number' && Number.isFinite(highest)) extra['highest_trophies'] = highest;
  if (typeof player.expLevel === 'number' && Number.isFinite(player.expLevel)) extra['exp_level'] = player.expLevel;
  if (typeof player.expPoints === 'number' && Number.isFinite(player.expPoints)) extra['exp_points'] = player.expPoints;
  if (typeof player.nameColor === 'string') extra['name_color'] = player.nameColor;
  else if (typeof player.nameColor === 'number' && Number.isFinite(player.nameColor)) {
    extra['name_color'] = String(player.nameColor);
  }
  const iconId = player.icon && typeof (player.icon as { id?: unknown }).id === 'number'
    ? (player.icon as { id: number }).id
    : undefined;
  if (typeof iconId === 'number' && Number.isFinite(iconId)) extra['icon_id'] = iconId;
  if (typeof player.totalPrestigeLevel === 'number' && Number.isFinite(player.totalPrestigeLevel)) extra['total_prestige_level'] = player.totalPrestigeLevel;
  if (typeof player.fame === 'number' && Number.isFinite(player.fame)) extra['fame'] = player.fame;
  if (typeof player.fameTierName === 'string') extra['fame_tier_name'] = player.fameTierName;
  if (typeof player.isQualifiedFromChampionshipChallenge === 'boolean') {
    extra['is_qualified_from_championship_challenge'] = player.isQualifiedFromChampionshipChallenge;
  }
  if (typeof player['3vs3Victories'] === 'number' && Number.isFinite(player['3vs3Victories'])) extra['three_vs_three_victories'] = player['3vs3Victories'];
  if (typeof player.soloVictories === 'number' && Number.isFinite(player.soloVictories)) extra['solo_victories'] = player.soloVictories;
  if (typeof player.duoVictories === 'number' && Number.isFinite(player.duoVictories)) extra['duo_victories'] = player.duoVictories;
  if (typeof player.bestRoboRumbleTime === 'number' && Number.isFinite(player.bestRoboRumbleTime)) extra['best_robo_rumble_time'] = player.bestRoboRumbleTime;
  if (typeof player.bestTimeAsBigBrawler === 'number' && Number.isFinite(player.bestTimeAsBigBrawler)) extra['best_time_as_big_brawler'] = player.bestTimeAsBigBrawler;
  if (typeof player.rankedSeasonId === 'number' && Number.isFinite(player.rankedSeasonId)) extra['ranked_season_id'] = player.rankedSeasonId;
  if (typeof player.rankedRank === 'number' && Number.isFinite(player.rankedRank)) extra['ranked_rank'] = player.rankedRank;
  if (typeof player.rankedRankName === 'string') extra['ranked_rank_name'] = player.rankedRankName;
  if (typeof player.rankedElo === 'number' && Number.isFinite(player.rankedElo)) extra['ranked_elo'] = player.rankedElo;
  if (typeof player.highestSeasonRankedRank === 'number' && Number.isFinite(player.highestSeasonRankedRank)) extra['highest_season_ranked_rank'] = player.highestSeasonRankedRank;
  if (typeof player.highestSeasonRankedRankName === 'string') extra['highest_season_ranked_rank_name'] = player.highestSeasonRankedRankName;
  if (typeof player.highestSeasonRankedElo === 'number' && Number.isFinite(player.highestSeasonRankedElo)) extra['highest_season_ranked_elo'] = player.highestSeasonRankedElo;
  if (typeof player.highestAllTimeRankedRank === 'number' && Number.isFinite(player.highestAllTimeRankedRank)) extra['highest_all_time_ranked_rank'] = player.highestAllTimeRankedRank;
  if (typeof player.highestAllTimeRankedRankName === 'string') extra['highest_all_time_ranked_rank_name'] = player.highestAllTimeRankedRankName;
  if (typeof player.highestAllTimeRankedElo === 'number' && Number.isFinite(player.highestAllTimeRankedElo)) extra['highest_all_time_ranked_elo'] = player.highestAllTimeRankedElo;

  // Store rich details (brawlers, gadgets/gears, etc.) for display/history.
  extra['profile_extra'] = player as unknown as Record<string, unknown>;

  return extra;
}

async function fetchPlayerProfile(
  apiClient: BrawlStarsClient,
  tag: string,
  timeoutMs: number,
): Promise<Player | undefined> {
  try {
    return await withTimeout(apiClient.getPlayer(tag), timeoutMs, `getPlayer(${tag})`);
  } catch (error) {
    log.warn('Player profile fetch failed', { tag, reason: sanitizeError(error) });
    return undefined;
  }
}

async function upsertPlayer(
  db: SupabaseClient,
  apiClient: BrawlStarsClient,
  entry: RosterEntry,
  nowIso: string,
  timeoutMs: number,
  fullProfile?: Player,
): Promise<string> {
  const existing = await db.from('players').select('id').eq('tag', entry.tag).maybeSingle();
  requireOk(existing.error, `Read player ${entry.tag}`);

  const extra: Record<string, unknown> = {};
  if (fullProfile !== undefined) {
    Object.assign(extra, playerProfilePayload(fullProfile));
  } else if (existing.data === null && process.env.SYNC_ENRICH_NEW_PLAYERS === 'true') {
    const player = await fetchPlayerProfile(apiClient, entry.tag, timeoutMs);
    if (player !== undefined) {
      Object.assign(extra, playerProfilePayload(player));
    }
  }

  // Roster values remain authoritative for current club-member identity.
  extra['name'] = entry.name;
  extra['trophies'] = entry.trophies;

  const payload: Record<string, unknown> = {
    tag: entry.tag,
    ...extra,
    last_synced_at: nowIso,
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

async function readOpenMembershipsForClubs(
  db: SupabaseClient,
  clubIds: readonly string[],
): Promise<OpenMembershipRow[]> {
  if (clubIds.length === 0) return [];
  const result = await db
    .from('club_memberships')
    .select('id, club_id, player_id, role')
    .in('club_id', [...clubIds])
    .is('valid_to', null);
  requireOk(result.error, 'Read open memberships');
  return (result.data ?? []) as OpenMembershipRow[];
}

/**
 * Reads every event owned by this run. Notifications are derived from this list
 * rather than from the current membership state, so a retry after a partial
 * failure can still deliver claims for events that were already committed.
 */
async function readRunEvents(db: SupabaseClient, runId: string): Promise<RunEventRow[]> {
  const result = await db
    .from('membership_events')
    .select('id, player_id, event_type, from_club_id, to_club_id')
    .eq('source_sync_run_id', runId)
    .order('detected_at', { ascending: true });
  requireOk(result.error, 'Read run events');
  return (result.data ?? []) as RunEventRow[];
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

export interface RunSyncOptions {
  now?: Date;
  notifier?: SyncNotifier;
  notifierForGuild?: (guildId: string) => SyncNotifier | undefined | Promise<SyncNotifier | undefined>;
  client?: BrawlStarsClient;
  guildId?: string;
}

async function listGuildIdsWithRegisteredClubs(db: SupabaseClient): Promise<string[]> {
  const result = await db.from('clubs').select('guild_id').is('archived_at', null);
  requireOk(result.error, 'List guilds with registered clubs');
  const ids = new Set<string>();
  for (const row of (result.data ?? []) as Array<{ guild_id?: string | null }>) {
    const id = typeof row.guild_id === 'string' ? row.guild_id.trim() : '';
    if (id.length > 0) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Run sync separately for every guild that currently has registered clubs.
 * Returns one result per guild run; an overall failure is returned if guild
 * discovery fails.
 */
export async function runSyncForAllGuilds(
  options: Omit<RunSyncOptions, 'guildId'> = {},
): Promise<SyncResult[]> {
  let db: SupabaseClient;
  try {
    db = createTrustedClient();
  } catch (error) {
    return [
      {
        syncRunId: '',
        status: 'failed',
        ...emptyCounters(),
        error: sanitizeError(error),
        affectedClubIds: [],
      },
    ];
  }

  let guildIds: string[];
  try {
    guildIds = await listGuildIdsWithRegisteredClubs(db);
  } catch (error) {
    return [
      {
        syncRunId: '',
        status: 'failed',
        ...emptyCounters(),
        error: sanitizeError(error),
        affectedClubIds: [],
      },
    ];
  }

  if (guildIds.length === 0) {
    return [skippedResult('', 'No clubs registered')];
  }

  const results: SyncResult[] = [];
  for (const guildId of guildIds) {
    const notifier =
      options.notifierForGuild === undefined
        ? options.notifier
        : await options.notifierForGuild(guildId);
    const runOptions: RunSyncOptions = { ...options, guildId };
    if (notifier !== undefined) runOptions.notifier = notifier;
    else delete (runOptions as { notifier?: SyncNotifier }).notifier;
    results.push(await runSync(runOptions));
  }
  return results;
}

export async function runSync(options: RunSyncOptions = {}): Promise<SyncResult> {
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
  const collectBattleLogsEnabled = readBooleanEnv('SYNC_COLLECT_BATTLE_LOGS', true);

  const requestedGuildId = options.guildId?.trim();
  const scope =
    requestedGuildId !== undefined && requestedGuildId.length > 0
      ? guildSyncScope(requestedGuildId)
      : SYNC_SCOPE;

  let clubRows: ClubRow[];
  try {
    let clubsQuery = db
      .from('clubs')
      .select('id, tag, name, guild_id')
      .is('archived_at', null)
      .order('tag', {
        ascending: true,
      });
    if (requestedGuildId !== undefined && requestedGuildId.length > 0) {
      clubsQuery = clubsQuery.eq('guild_id', requestedGuildId);
    }
    const clubsResult = await clubsQuery;
    requireOk(clubsResult.error, 'Load registered clubs');
    clubRows = (clubsResult.data ?? []) as ClubRow[];
  } catch (error) {
    const message = sanitizeError(error);
    log.error('Sync failed before acquiring a run', { message, scope });
    return {
      syncRunId: '',
      status: 'failed',
      ...emptyCounters(),
      error: message,
      affectedClubIds: [],
    };
  }

  if (clubRows.length === 0) {
    return skippedResult(
      '',
      requestedGuildId !== undefined && requestedGuildId.length > 0
        ? 'No clubs registered for this server'
        : 'No clubs registered',
    );
  }

  const clubIds = clubRows.map((club) => club.id);
  const clubIdSet = new Set(clubIds);
  const clubTags = clubRows.map((club) => club.tag);
  const clubNames = new Map(clubRows.map((club) => [club.id, club.name]));

  let runId: string | undefined;
  let affectedColumns = true;
  const counters = emptyCounters();
  const lockToken = randomUUID();
  let lockHeld = false;

  try {
    try {
      lockHeld = await acquireSyncLock(db, scope, lockToken);
    } catch (error) {
      const message = sanitizeError(error);
      log.error('Sync lock acquisition failed', { message, scope });
      return {
        syncRunId: '',
        status: 'failed',
        ...emptyCounters(),
        error: message,
        affectedClubIds: clubIds,
      };
    }
    if (!lockHeld) {
      return skippedResult('', 'Another sync process holds the database lock');
    }

    const acquired = await acquireRun(db, scope, periodStartIso, nowIso, nowMs, clubIds, clubTags);
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
    const collectPlayerProfiles = readBooleanEnv('SYNC_COLLECT_PLAYER_PROFILES', true);
    const states: RosterState[] = [];
    for (const entry of roster.values()) {
      const fullProfile = collectPlayerProfiles
        ? await fetchPlayerProfile(apiClient, entry.tag, apiTimeoutMs)
        : undefined;
      const playerId = await upsertPlayer(db, apiClient, entry, nowIso, apiTimeoutMs, fullProfile);
      states.push({ ...entry, playerId });
      counters.playersUpserted += 1;
    }
    const presentPlayerIds = new Set(states.map((state) => state.playerId));

    // 3. Joins and transfers, computed against the synced guild roster. Each
    //    event + membership change is committed atomically by Postgres.
    for (const state of states) {
      const open = await readOpenMembership(db, state.playerId);
      if (open !== undefined && open.club_id === state.clubId) {
        continue;
      }
      if (open !== undefined && !clubIdSet.has(open.club_id)) {
        throw new Error(
          `Player ${state.tag} has an open membership in a club outside this sync scope; refusing to mutate cross-guild membership state`,
        );
      }
      const eventType: EventType = open === undefined ? 'join' : 'transfer';
      await applyMembershipTransition(db, {
        playerId: state.playerId,
        eventType,
        fromClubId: open?.club_id,
        toClubId: state.clubId,
        detectedAt: nowIso,
        runId,
        role: state.role,
        validFrom: nowIso,
        closeMembershipId: open?.id,
      });
      counters.membershipEvents += 1;
    }

    // 4. Leaves for open memberships in this scope absent from the synced roster.
    const openMemberships = await readOpenMembershipsForClubs(db, clubIds);
    const leavingPlayers = new Map<string, { tag: string; name: string }>();
    for (const open of openMemberships) {
      if (presentPlayerIds.has(open.player_id)) {
        continue;
      }
      const player = await readPlayerLookup(db, open.player_id);
      leavingPlayers.set(open.player_id, player);
      await applyMembershipTransition(db, {
        playerId: open.player_id,
        eventType: 'leave',
        fromClubId: open.club_id,
        toClubId: undefined,
        detectedAt: nowIso,
        runId,
        role: open.role ?? undefined,
        validFrom: nowIso,
        closeMembershipId: open.id,
      });
      counters.membershipEvents += 1;
    }

    // Notifications are derived from persisted events, not from the live
    // membership state. A retry can therefore deliver an event that was
    // committed in an earlier failed attempt without creating a new event.
    const playerLookups = new Map<string, { tag: string; name: string }>();
    for (const state of states) {
      playerLookups.set(state.playerId, { tag: state.tag, name: state.name });
    }
    for (const [playerId, player] of leavingPlayers) {
      playerLookups.set(playerId, player);
    }
    const pendingNotifications: SyncNotificationInput[] = (await readRunEvents(db, runId)).map(
      (event) =>
        buildNotification(
          event.id,
          event.event_type as EventType,
          playerLookups.get(event.player_id) ?? { tag: '', name: '' },
          clubNames,
          event.from_club_id ?? undefined,
          event.to_club_id ?? undefined,
        ),
    );

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

    if (collectBattleLogsEnabled && states.length > 0 && runId !== undefined) {
      counters.battlesCollected = await collectBattleLogs(
        db,
        apiClient,
        states.map((state) => ({ playerId: state.playerId, tag: state.tag })),
        runId,
        apiTimeoutMs,
      );
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
  } finally {
    if (lockHeld) {
      await releaseSyncLock(db, scope, lockToken);
    }
  }
}
