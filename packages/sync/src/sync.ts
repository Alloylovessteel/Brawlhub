import { createHash, randomUUID } from 'node:crypto';
import {
  battleLogResponseSchema,
  clubMembersResponseSchema,
  clubSchema,
  getSharedBrawlStarsClient,
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
/** Refresh the held lock well before its TTL while a long sync is running. */
const SYNC_LOCK_RENEW_INTERVAL_MS = 5 * 60 * 1000;
/** Official Brawl Stars club member capacity; a club is "full" at this count. */
const CLUB_CAPACITY = 30;
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_NOTIFIER_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 1000;
/** Explicit retention window for recovering announcements after an outage. */
const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NOTIFICATIONS_PER_SYNC = 20;
/** Live claims are owned for this long before another run may take them over. */
const NOTIFICATION_LEASE_SECONDS = 120;
/** Page size for the unsent-event RPC; pagination stops at 20 collected events. */
const UNSENT_EVENT_PAGE_SIZE = 25;
const MAX_UNSENT_EVENT_PAGES = 100;
/** Open memberships are paged by id so the REST max_rows cap cannot hide departures. */
const OPEN_MEMBERSHIP_PAGE_SIZE = 500;
const MAX_OPEN_MEMBERSHIP_PAGES = 100;
/** Bounded fan-out for independent API reads and idempotent DB writes. */
const SYNC_FETCH_CONCURRENCY = 6;
const SYNC_WRITE_CONCURRENCY = 6;

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

export function battleKey(item: BattleLogItem): string {
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
    JSON.stringify(item.battle?.teams ?? []),
    JSON.stringify(item.battle?.starPlayer ?? null),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Named alias for the stable battle dedupe key used by the live battle worker. */
export function buildBattleKey(item: BattleLogItem): string {
  return battleKey(item);
}

export interface CollectedBattleLog {
  readonly playerId: string;
  readonly key: string;
  readonly battleTime: string;
  readonly mode: string | null;
  readonly map: string | null;
  readonly battleType: string | null;
  readonly result: string | null;
  readonly trophyChange: number | null;
  readonly raw: Record<string, unknown>;
}

export interface CollectBattleLogsOptions {
  /**
   * Emit every valid official battle to onCollected before the deduped write.
   * Kept for live delivery, whose own ledger is the authoritative dedupe source;
   * scheduled sync emits after a successful write instead.
   */
  readonly emitAllBattles?: boolean;
  /** Called for every battle row accepted for storage, for live delivery readers. */
  readonly onCollected?: (battle: CollectedBattleLog) => void;
  /** Called when a fetch or battle write fails for one player. */
  readonly onError?: (input: {
    readonly playerId: string;
    readonly tag: string;
    readonly phase: 'fetch' | 'write';
    readonly error: unknown;
  }) => void;
  /** Verified immediately before every mutation while a sync lease is held. */
  readonly assertBeforeWrite?: () => Promise<void>;
  /** Stops queued per-player work when the sync lease is lost. */
  readonly fence?: AbortSignal;
}

/**
 * Shared battle-log collector for scheduled sync and opted-in live tracking.
 * Every valid official battle is offered to the deduped `player_battles` write;
 * a late-arriving older battle is never discarded just because a newer one was
 * already seen. Only genuinely inserted rows are counted.
 */
export async function collectBattleLogs(
  db: SupabaseClient,
  client: BrawlStarsClient,
  states: ReadonlyArray<{ playerId: string; tag: string }>,
  syncRunId: string | null,
  timeoutMs: number,
  options: CollectBattleLogsOptions = {},
): Promise<number> {
  const byPlayer = new Map<string, string>();
  for (const state of states) byPlayer.set(state.playerId, state.tag);
  let inserted = 0;

  await mapWithConcurrency(
    [...byPlayer.entries()],
    SYNC_WRITE_CONCURRENCY,
    async ([playerId, tag]) => {
      let items: BattleLogItem[];
      try {
        items = await withTimeout(client.getBattleLog(tag), timeoutMs, `Battle log for ${tag}`);
      } catch (error) {
        log.warn('Battle log fetch failed', {
          tag,
          syncRunId,
          reason: sanitizeError(error),
        });
        options.onError?.({ playerId, tag, phase: 'fetch', error });
        return;
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
      if (rows.length === 0) return;

      const emit = (row: NonNullable<typeof rows[number]>): void => {
        options.onCollected?.({
          playerId: row.player_id,
          key: row.battle_key,
          battleTime: row.battle_time,
          mode: row.mode,
          map: row.map,
          battleType: row.battle_type,
          result: row.result,
          trophyChange: row.trophy_change,
          raw: row.raw,
        });
      };
      if (options.emitAllBattles === true) {
        for (const row of rows) emit(row);
      }

      await options.assertBeforeWrite?.();
      const result = await db
        .from('player_battles')
        .upsert(rows, { onConflict: 'player_id,battle_key', ignoreDuplicates: true })
        .select('id');
      if (result.error) {
        log.warn('Battle log write failed', {
          tag,
          syncRunId,
          reason: result.error.message,
        });
        options.onError?.({ playerId, tag, phase: 'write', error: result.error });
        return;
      }
      const insertedRows = Array.isArray(result.data) ? result.data : [];
      inserted += insertedRows.length;

      if (options.emitAllBattles !== true) {
        for (const row of rows) emit(row);
      }

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
          await options.assertBeforeWrite?.();
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
    },
    options.fence,
  );

  return inserted;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Legacy notifiers return a message id or undefined. Structured outcomes let a
 * notifier prove a definite rejection without turning a timeout into a retry
 * that could duplicate a message Discord actually accepted.
 */
export type SyncNotifierSendResult =
  | string
  | undefined
  | { readonly kind: 'sent'; readonly messageId: string }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly reason?: string }
  | { readonly kind: 'uncertain' };

export interface SyncNotifier {
  send(input: {
    eventId: string;
    eventType: 'join' | 'leave' | 'transfer';
    playerTag: string;
    playerName: string;
    clubName: string;
    fromClubName: string | undefined;
    toClubName: string | undefined;
    /** Stored event detection time (ISO), used by the public notice for its date/time line. */
    occurredAt?: string;
    /** Latest official member count for the club involved in the event. */
    remainingMembers?: number;
  }): Promise<SyncNotifierSendResult>;
}

export interface SyncMemberFailure {
  tag: string;
  name: string;
  reason: string;
}

export interface SyncResult {
  syncRunId: string;
  status: 'completed' | 'skipped' | 'failed';
  clubsProcessed: number;
  playersUpserted: number;
  snapshotsWritten: number;
  membershipEvents: number;
  notificationsSent: number;
  battlesCollected: number;
  error: string | undefined;
  affectedClubIds: string[];
  /** Optional operator-notification context; no database schema change. */
  guildId?: string;
  membersExpected?: number;
  membersSucceeded?: number;
  memberFailures?: readonly SyncMemberFailure[];
  /** False when this run intentionally refreshed rosters without player profiles. */
  profileRefreshEnabled?: boolean | undefined;
  /** Run-scoped timestamp only; not a persistent per-player profile timestamp. */
  lastSuccessfulProfileRefreshAt?: string | null | undefined;
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
  sync_run_id?: string | null;
}

interface PendingEventRow {
  id: string;
  player_id: string;
  event_type: string;
  from_club_id: string | null;
  to_club_id: string | null;
  detected_at: string;
  player?: { tag?: unknown; name?: unknown } | null;
  from_club?: { name?: unknown } | null;
  to_club?: { name?: unknown } | null;
}

/** Flat row returned by `list_unsent_membership_events`. */
interface UnsentEventRow {
  id: string;
  player_id: string;
  event_type: string;
  from_club_id: string | null;
  to_club_id: string | null;
  detected_at: string;
  player_tag?: string | null;
  player_name?: string | null;
  from_club_name?: string | null;
  to_club_name?: string | null;
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
  roleChanges: number;
  capacityEvents: number;
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
  guildId: string;
  lockScope: string;
  lockToken: string;
}

interface RoleChangeInput {
  clubId: string;
  playerId: string;
  membershipId: string;
  fromRole: string | null;
  toRole: string | null;
  detectedAt: string;
  runId: string;
  guildId: string;
  lockScope: string;
  lockToken: string;
}

interface CapacityEventInput {
  clubId: string;
  fromCount: number;
  toCount: number;
  isFull: boolean;
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

/**
 * Run independent items with a bounded concurrency. Results stay in input
 * order. The first error or an aborted lock lease stops new work while
 * already-started work drains, so a lost lease cannot start fresh mutations.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  fence?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (firstError === undefined && fence?.aborted !== true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        firstError = error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  if (fence?.aborted === true) {
    throw new Error('Sync lock lost while work was in progress; aborting run');
  }
  return results;
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
    roleChanges: 0,
    capacityEvents: 0,
    notificationsSent: 0,
    battlesCollected: 0,
  };
}

function guildContext(guildId: string | undefined): { readonly guildId?: string } {
  return guildId === undefined || guildId === '' ? {} : { guildId };
}

function skippedResult(syncRunId: string, error: string, guildId?: string): SyncResult {
  return {
    syncRunId,
    status: 'skipped',
    ...emptyCounters(),
    error,
    affectedClubIds: [],
    ...(guildId === undefined || guildId === '' ? {} : { guildId }),
  };
}

function buildNotification(
  eventId: string,
  eventType: EventType,
  player: { tag: string; name: string },
  clubNames: ReadonlyMap<string, string>,
  fromClubId: string | undefined,
  toClubId: string | undefined,
  occurredAt: string,
  remainingMembers: number | undefined,
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
    occurredAt,
    ...(remainingMembers === undefined ? {} : { remainingMembers }),
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

async function insertRun(
  db: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const result = await db.from('sync_runs').insert(payload).select('id').single();
  return { data: result.data, error: result.error };
}

async function upsertRun(
  db: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  // A retry updates one specific run row. New attempts are inserted instead,
  // so a previous completed run is never reused as a running/failed attempt.
  const result = await db
    .from('sync_runs')
    .upsert(payload, { onConflict: 'id' })
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
  force: boolean,
): Promise<AcquireOutcome> {
  // Several attempts can share one scope/period after a forced sync. Always
  // inspect the newest attempt; a forced run creates another row and leaves
  // the previously published completed row untouched.
  const existingResult = await db
    .from('sync_runs')
    .select('id, status, started_at')
    .eq('scope', scope)
    .eq('period_start', periodStartIso)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  requireOk(existingResult.error, 'Read sync_runs');
  const existing = (existingResult.data ?? null) as RunRow | null;

  if (existing?.status === 'completed' && !force) {
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

  // Force starts a separate attempt. Reuse is reserved for failed/stale rows
  // on the normal path, where the run id is part of the event idempotency key.
  const reusedId = force ? undefined : existing?.id;
  const writeRun = force ? insertRun : upsertRun;
  let affectedColumns = true;
  let result = await writeRun(
    db,
    runPayload(reusedId, scope, periodStartIso, nowIso, clubIds, clubTags, true),
  );
  if (result.error !== null && result.error !== undefined && isUndefinedColumnError(result.error)) {
    affectedColumns = false;
    result = await writeRun(
      db,
      runPayload(reusedId, scope, periodStartIso, nowIso, clubIds, clubTags, false),
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

/** Extend the TTL of a lock still owned by this sync process. */
export async function renewSyncLock(
  db: SupabaseClient,
  scope: string,
  token: string,
): Promise<boolean> {
  const result = await db.rpc('renew_sync_lock', {
    p_scope: scope,
    p_token: token,
    p_ttl_seconds: SYNC_LOCK_TTL_SECONDS,
  });
  requireOk(result.error, 'Renew sync lock');
  return result.data === token;
}

/** Heartbeat handle. `signal` aborts as soon as ownership is lost. */
export interface SyncLockRenewal {
  readonly signal: AbortSignal;
  /** True once a renewal proved the lock was lost or could not be verified. */
  readonly lost: boolean;
  /** Record an externally observed ownership failure and abort the run. */
  reportLoss(reason: string): void;
  stop(): Promise<void>;
}

/**
 * Heartbeat that keeps a long-running sync's lock alive. Losing the lock aborts
 * the returned signal and calls `onLost`; callers must stop before their next
 * write phase. The final release still happens in `finally`.
 */
export function startSyncLockRenewal(
  db: SupabaseClient,
  scope: string,
  token: string,
  intervalMs: number,
  onLost?: (reason: string) => void,
): SyncLockRenewal {
  let stopped = false;
  let lost = false;
  let inFlight: Promise<void> | null = null;
  const controller = new AbortController();

  const markLost = (reason: string): void => {
    if (lost) return;
    lost = true;
    log.warn('Sync lock lost; stopping run', { scope, reason });
    controller.abort(reason);
    try {
      onLost?.(reason);
    } catch (error) {
      log.warn('Sync lock loss callback failed', { scope, reason: sanitizeError(error) });
    }
  };

  const renew = async (): Promise<void> => {
    if (stopped || inFlight !== null) return;
    inFlight = (async () => {
      try {
        const held = await renewSyncLock(db, scope, token);
        if (!held) {
          markLost('Sync lock renewal lost ownership');
        }
      } catch (error) {
        markLost(`Sync lock renewal failed: ${sanitizeError(error)}`);
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const timer = setInterval(() => {
    void renew();
  }, Math.max(1, intervalMs));
  const nodeTimer = timer as unknown as { unref?: () => void };
  nodeTimer.unref?.();

  return {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get lost(): boolean {
      return lost;
    },
    reportLoss: markLost,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (inFlight !== null) await inFlight;
    },
  };
}

export interface SyncRecoveryResult {
  readonly recoveredRuns: number;
  readonly clearedScopes: string[];
}

/**
 * Clear run rows and lock claims left behind when a process exits mid-sync.
 * The whole decision and all writes happen in one database RPC: a concurrent
 * startup cannot slip a new lock between our select and our update. Scopes with
 * a still-active owner are left untouched, so a healthy process is never
 * marked failed by a concurrent startup.
 */
export async function recoverInterruptedSyncs(
  db: SupabaseClient = createTrustedClient(),
  nowIso: string = new Date().toISOString(),
): Promise<SyncRecoveryResult> {
  const result = await db.rpc('recover_interrupted_syncs', { p_now: nowIso });
  requireOk(result.error, 'Recover interrupted syncs');

  const payload = (result.data ?? {}) as {
    recoveredRuns?: unknown;
    clearedScopes?: unknown;
  };
  const recoveredRuns =
    typeof payload.recoveredRuns === 'number' && Number.isFinite(payload.recoveredRuns)
      ? Math.max(0, Math.trunc(payload.recoveredRuns))
      : 0;
  const clearedScopes = Array.isArray(payload.clearedScopes)
    ? [
        ...new Set(
          payload.clearedScopes.filter(
            (scope): scope is string => typeof scope === 'string' && scope.length > 0,
          ),
        ),
      ].sort()
    : [];

  if (recoveredRuns > 0 || clearedScopes.length > 0) {
    log.warn('Recovered interrupted sync state', {
      runs: recoveredRuns,
      scopes: clearedScopes.join(', '),
    });
  }
  return { recoveredRuns, clearedScopes };
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
    p_guild_id: input.guildId,
    p_lock_scope: input.lockScope,
    p_lock_token: input.lockToken,
  });
  requireOk(result.error, `Apply ${input.eventType} transition`);
  return typeof result.data === 'string' ? result.data : undefined;
}

/** Roles are case-sensitive API strings; null/undefined/blank all mean "no role". */
function normalizeRole(role: string | null | undefined): string | null {
  if (typeof role !== 'string' || role.trim() === '') return null;
  return role;
}

/** Records a same-club role change without creating a membership event. */
async function applyClubRoleChange(db: SupabaseClient, input: RoleChangeInput): Promise<void> {
  const result = await db.rpc('apply_club_role_change', {
    p_club_id: input.clubId,
    p_player_id: input.playerId,
    p_membership_id: input.membershipId,
    p_from_role: input.fromRole,
    p_to_role: input.toRole,
    p_detected_at: input.detectedAt,
    p_run_id: input.runId,
    p_valid_from: input.detectedAt,
    p_guild_id: input.guildId,
    p_lock_scope: input.lockScope,
    p_lock_token: input.lockToken,
  });
  requireOk(result.error, 'Apply club role change');
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
  onFailure?: (reason: string) => void,
): Promise<Player | undefined> {
  try {
    return await withTimeout(apiClient.getPlayer(tag), timeoutMs, `getPlayer(${tag})`);
  } catch (error) {
    const reason = sanitizeError(error);
    log.warn('Player profile fetch failed', { tag, reason });
    onFailure?.(reason);
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
  assertBeforeWrite?: () => Promise<void>,
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
  await assertBeforeWrite?.();
  const result = await db
    .from('players')
    .upsert(payload, { onConflict: 'tag' })
    .select('id')
    .single();
  requireOk(result.error, `Upsert player ${entry.tag}`);
  return requireRow<IdRow>(result.data, `Upsert player ${entry.tag}`).id;
}

async function readOpenMembershipsForClubs(
  db: SupabaseClient,
  clubIds: readonly string[],
): Promise<OpenMembershipRow[]> {
  if (clubIds.length === 0) return [];
  const collected: OpenMembershipRow[] = [];
  const seen = new Set<string>();
  let afterId: string | null = null;

  for (let page = 0; page < MAX_OPEN_MEMBERSHIP_PAGES; page += 1) {
    const result = await db.rpc('list_open_club_memberships', {
      p_club_ids: [...clubIds],
      p_limit: OPEN_MEMBERSHIP_PAGE_SIZE,
      p_after_id: afterId,
    });
    requireOk(result.error, 'Read open memberships');
    const rows = (Array.isArray(result.data) ? result.data : []) as OpenMembershipRow[];
    if (rows.length === 0) return collected;

    let lastId: string | null = null;
    for (const row of rows) {
      if (
        typeof row.id !== 'string' ||
        typeof row.club_id !== 'string' ||
        typeof row.player_id !== 'string' ||
        (row.role !== null && typeof row.role !== 'string')
      ) {
        throw new Error('Read open memberships: malformed row');
      }
      if (seen.has(row.id) || (afterId !== null && row.id <= afterId)) {
        throw new Error('Read open memberships: non-monotonic keyset');
      }
      seen.add(row.id);
      collected.push(row);
      lastId = row.id;
    }
    if (rows.length < OPEN_MEMBERSHIP_PAGE_SIZE) return collected;
    if (lastId === null) throw new Error('Read open memberships: missing keyset');
    afterId = lastId;
  }

  throw new Error('Read open memberships: page limit exceeded');
}

function toPendingEvent(row: UnsentEventRow): PendingEventRow | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.event_type !== 'string' ||
    typeof row.detected_at !== 'string' ||
    typeof row.player_id !== 'string'
  ) {
    return null;
  }
  const event: PendingEventRow = {
    id: row.id,
    player_id: row.player_id,
    event_type: row.event_type,
    from_club_id: row.from_club_id ?? null,
    to_club_id: row.to_club_id ?? null,
    detected_at: row.detected_at,
    player: { tag: row.player_tag ?? '', name: row.player_name ?? '' },
  };
  if (typeof row.from_club_name === 'string') {
    event.from_club = { name: row.from_club_name };
  }
  if (typeof row.to_club_name === 'string') {
    event.to_club = { name: row.to_club_name };
  }
  return event;
}

/**
 * Reads the oldest unsent membership events involving this guild's clubs. The
 * guild-scoped RPC filters delivered and uncertain claims in SQL and pages
 * oldest-first, so a steady stream of newer events cannot starve the backlog.
 */
async function readPendingEvents(
  db: SupabaseClient,
  guildId: string,
  clubIds: readonly string[],
  nowIso: string,
  ownerId: string,
): Promise<PendingEventRow[]> {
  if (clubIds.length === 0) return [];
  const sinceIso = new Date(Date.parse(nowIso) - NOTIFICATION_RETENTION_MS).toISOString();
  const collected: PendingEventRow[] = [];
  const seen = new Set<string>();
  let afterDetectedAt: string | null = null;
  let afterId: string | null = null;

  for (let page = 0; page < MAX_UNSENT_EVENT_PAGES && collected.length < MAX_NOTIFICATIONS_PER_SYNC; page += 1) {
    const result = await db.rpc('list_oldest_unsent_membership_events', {
      p_guild_id: guildId,
      p_club_ids: [...clubIds],
      p_since: sinceIso,
      p_limit: UNSENT_EVENT_PAGE_SIZE,
      p_after_detected_at: afterDetectedAt,
      p_after_id: afterId,
    });
    requireOk(result.error, 'List unsent membership events');

    const rows = (Array.isArray(result.data) ? result.data : []) as UnsentEventRow[];
    if (rows.length === 0) break;
    let lastCursor: { detectedAt: string; id: string } | null = null;
    const normalizedRows: PendingEventRow[] = [];
    for (const item of rows) {
      if (
        afterId !== null &&
        typeof item.detected_at === 'string' &&
        typeof item.id === 'string' &&
        item.detected_at === afterDetectedAt &&
        item.id <= afterId
      ) {
        throw new Error('List unsent membership events: non-monotonic keyset');
      }
      const normalized = toPendingEvent(item);
      if (normalized !== null && !seen.has(normalized.id)) normalizedRows.push(normalized);
      if (typeof item.detected_at === 'string' && typeof item.id === 'string') {
        lastCursor = { detectedAt: item.detected_at, id: item.id };
      }
    }

    // Claims are checked before an event counts toward the announcement limit.
    // Otherwise a page full of already-announced events would stop the scan and
    // starve older undelivered events behind them.
    const claimed = await readClaimedEventIds(db, normalizedRows, ownerId, nowIso);
    for (const normalized of normalizedRows) {
      if (claimed.has(normalized.id)) continue;
      seen.add(normalized.id);
      collected.push(normalized);
      if (collected.length >= MAX_NOTIFICATIONS_PER_SYNC) break;
    }
    if (lastCursor === null) break;
    if (lastCursor.detectedAt === afterDetectedAt && lastCursor.id === afterId) break;
    afterDetectedAt = lastCursor.detectedAt;
    afterId = lastCursor.id;
  }

  return collected;
}

type NotificationDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';

function deliveryStatus(value: unknown): NotificationDeliveryStatus | null {
  return value === 'pending' ||
    value === 'sending' ||
    value === 'sent' ||
    value === 'failed' ||
    value === 'uncertain'
    ? value
    : null;
}

/**
 * Delivered claims and live leases owned by this run suppress announcements.
 * A live lease owned by another run is NOT delivered: the claim RPC will refuse
 * to take it over until it expires, but treating it as sent would lose the event.
 */
async function readClaimedEventIds(
  db: SupabaseClient,
  events: readonly PendingEventRow[],
  ownerId: string,
  nowIso: string,
): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  const eventIds = [...new Set(events.map((event) => event.id))];
  const [delivered, sameRun] = await Promise.all([
    db
      .from('notifications')
      .select('event_id, delivery_status')
      .in('event_id', eventIds)
      .in('delivery_status', ['sending', 'sent', 'uncertain']),
    db
      .from('notifications')
      .select('event_id, delivery_status, delivery_owner, lease_until')
      .in('event_id', eventIds)
      .eq('delivery_status', 'pending')
      .eq('delivery_owner', ownerId)
      .gte('lease_until', nowIso),
  ]);
  requireOk(delivered.error, 'Read delivered notification claims');
  requireOk(sameRun.error, 'Read this run notification claims');

  const claimed = new Set<string>();
  for (const item of delivered.data ?? []) {
    const row = item as { event_id?: unknown; delivery_status?: unknown } | null;
    const id = row?.event_id;
    // Legacy rows predate the status column and were only created for delivery.
    const status = deliveryStatus(row?.delivery_status);
    if (
      typeof id === 'string' &&
      (status === null || status === 'sending' || status === 'sent' || status === 'uncertain')
    ) {
      claimed.add(id);
    }
  }
  for (const item of sameRun.data ?? []) {
    const id = (item as { event_id?: unknown } | null)?.event_id;
    if (typeof id === 'string') claimed.add(id);
  }
  return claimed;
}

/** Atomically insert or take over a notification claim for one sync run. */
async function claimNotification(
  db: SupabaseClient,
  input: SyncNotificationInput,
  channelId: string,
  ownerId: string,
): Promise<string | null> {
  const result = await db.rpc('claim_notification', {
    p_event_id: input.eventId,
    p_channel_id: channelId,
    p_kind: input.eventType,
    p_owner: ownerId,
    p_lease_seconds: NOTIFICATION_LEASE_SECONDS,
  });
  requireOk(result.error, 'Claim notification');
  return typeof result.data === 'string' && result.data.length > 0 ? result.data : null;
}

async function writeSnapshot(
  db: SupabaseClient,
  write: SnapshotWrite,
  assertBeforeWrite?: () => Promise<void>,
): Promise<boolean> {
  const latestResult = await db
    .from(write.table)
    .select('payload_hash, sync_run_id')
    .eq(write.entityColumn, write.entityId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  requireOk(latestResult.error, `Read latest ${write.table}`);
  const latest = (latestResult.data ?? null) as SnapshotHashRow | null;
  if (latest?.payload_hash === write.hash) {
    // A snapshot from a failed/running run must not suppress the identical
    // payload in a later completed run: history only trusts completed runs.
    const runId = latest.sync_run_id;
    if (typeof runId !== 'string' || runId === '') return false;
    const runResult = await db
      .from('sync_runs')
      .select('status')
      .eq('id', runId)
      .maybeSingle();
    requireOk(runResult.error, 'Read snapshot run status');
    const status = (runResult.data as { status?: unknown } | null)?.status;
    if (status === undefined || status === 'completed') return false;
    // The matching hash came from an untrusted run; write a valid snapshot.
  }

  const payload: Record<string, unknown> = {
    [write.entityColumn]: write.entityId,
    sync_run_id: write.runId,
    captured_at: write.capturedAt,
    payload_hash: write.hash,
    raw: write.raw,
    ...write.extra,
  };
  await assertBeforeWrite?.();
  const result = await db.from(write.table).upsert(payload, {
    onConflict: `${write.entityColumn},sync_run_id`,
  });
  requireOk(result.error, `Write ${write.table}`);
  return true;
}

/**
 * Reads the last stored member count for one club from its snapshots. The club
 * id comes from this sync's registered-club set, so the read is guild-scoped.
 */
async function readPreviousMemberCount(
  db: SupabaseClient,
  clubId: string,
): Promise<number | undefined> {
  const result = await db
    .from('club_snapshots')
    .select('member_count')
    .eq('club_id', clubId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  requireOk(result.error, `Read latest club snapshot for ${clubId}`);
  const value = (result.data as { member_count?: unknown } | null)?.member_count;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Idempotent capacity open/close record; ordinary count changes are ignored. */
async function recordCapacityEvent(db: SupabaseClient, input: CapacityEventInput): Promise<void> {
  const result = await db.from('club_capacity_events').upsert(
    {
      club_id: input.clubId,
      from_count: input.fromCount,
      to_count: input.toCount,
      is_full: input.isFull,
      source_sync_run_id: input.runId,
      detected_at: input.detectedAt,
    },
    { onConflict: 'club_id,is_full,source_sync_run_id', ignoreDuplicates: true },
  );
  requireOk(result.error, `Write club capacity event for ${input.clubId}`);
}

function notificationReason(value: unknown): string {
  const text = sanitizeError(value);
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

/** Move the claim to a durable pre-send state before contacting Discord. */
async function beginNotificationSend(
  db: SupabaseClient,
  claimId: string,
  ownerId: string,
): Promise<boolean> {
  const result = await db
    .from('notifications')
    .update({ delivery_status: 'sending', lease_until: null })
    .eq('id', claimId)
    .eq('delivery_owner', ownerId)
    .eq('delivery_status', 'pending')
    .select('id');
  requireOk(result.error, 'Mark notification claim sending');
  const updated = Array.isArray(result.data) && result.data.length === 1;
  if (!updated) {
    log.warn('Notification claim was not available for sending', { eventId: claimId });
  }
  return updated;
}

async function markNotificationClaimFailed(
  db: SupabaseClient,
  claimId: string,
  ownerId: string,
  error: unknown,
): Promise<void> {
  // A definitive rejection proves no message exists, so the row becomes
  // retryable after the lease check. `sending` rows are never reclaimed.
  const reason = notificationReason(error);
  const failed = await db
    .from('notifications')
    .update({
      delivery_status: 'failed',
      delivery_reason: reason,
      delivery_owner: null,
      claimed_at: null,
      lease_until: null,
    })
    .eq('id', claimId)
    .eq('delivery_owner', ownerId)
    .eq('delivery_status', 'sending')
    .select('id');
  if (failed.error !== null && failed.error !== undefined) {
    log.warn('Could not mark notification claim failed', {
      eventId: claimId,
      reason: sanitizeError(failed.error),
    });
  } else if (!Array.isArray(failed.data) || failed.data.length !== 1) {
    log.warn('Notification claim was not active while marking failure', { eventId: claimId });
  }
  log.warn('Notification delivery failed; claim marked for retry', {
    eventId: claimId,
    reason,
  });
}

type NormalizedNotifierSend =
  | { readonly kind: 'sent'; readonly messageId: string }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly reason?: string }
  | { readonly kind: 'uncertain' };

function normalizeNotifierSend(value: SyncNotifierSendResult): NormalizedNotifierSend {
  if (typeof value === 'string') {
    return value.trim() === '' ? { kind: 'uncertain' } : { kind: 'sent', messageId: value };
  }
  if (value === undefined) return { kind: 'uncertain' };
  if (value.kind === 'sent') {
    return value.messageId.trim() === ''
      ? { kind: 'uncertain' }
      : { kind: 'sent', messageId: value.messageId };
  }
  return value;
}

async function markNotificationClaimUncertain(
  db: SupabaseClient,
  claimId: string,
  ownerId: string,
  error: unknown,
): Promise<void> {
  const reason = notificationReason(error);
  const update = await db
    .from('notifications')
    .update({ delivery_status: 'uncertain', delivery_reason: reason, lease_until: null })
    .eq('id', claimId)
    .eq('delivery_owner', ownerId)
    .eq('delivery_status', 'sending')
    .select('id');
  if (update.error !== null && update.error !== undefined) {
    log.warn('Could not mark notification claim uncertain', {
      eventId: claimId,
      reason: sanitizeError(update.error),
    });
  } else if (!Array.isArray(update.data) || update.data.length !== 1) {
    log.warn('Notification claim was not active while marking uncertain', { eventId: claimId });
  }
  log.warn('Notification delivery outcome is uncertain; claim will not be auto-reposted', {
    eventId: claimId,
    reason,
  });
}

async function recordLateNotificationDelivery(
  db: SupabaseClient,
  claimId: string,
  ownerId: string,
  messageId: string,
): Promise<void> {
  const update = await db
    .from('notifications')
    .update({
      delivery_status: 'sent',
      discord_message_id: messageId,
      delivered_at: new Date().toISOString(),
      delivery_reason: 'late Discord success',
      lease_until: null,
    })
    .eq('id', claimId)
    .eq('delivery_owner', ownerId)
    .in('delivery_status', ['sending', 'uncertain'])
    .select('id');
  if (update.error !== null && update.error !== undefined) {
    log.warn('Could not record late notification delivery', {
      eventId: claimId,
      reason: sanitizeError(update.error),
    });
  } else if (!Array.isArray(update.data) || update.data.length !== 1) {
    log.warn('Notification claim was not available for late delivery', { eventId: claimId });
  }
}

/** withTimeout does not cancel Discord; record a message that arrives after it. */
function observeLateNotificationSuccess(
  db: SupabaseClient,
  sendPromise: Promise<SyncNotifierSendResult>,
  claimId: string,
  ownerId: string,
): void {
  void sendPromise
    .then((value) => {
      const outcome = normalizeNotifierSend(value);
      if (outcome.kind === 'sent') {
        void recordLateNotificationDelivery(db, claimId, ownerId, outcome.messageId);
      }
    })
    .catch(() => {
      // A late rejection still proves nothing; the uncertain claim stays put.
    });
}

async function sendNotifications(
  db: SupabaseClient,
  notifier: SyncNotifier,
  pending: readonly SyncNotificationInput[],
  timeoutMs: number,
  ownerId: string,
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

    const claimId = await claimNotification(db, input, channelId, ownerId);
    if (claimId === null) {
      continue; // Already delivered or leased by another live run.
    }

    // Persist the pre-send state before Discord sees the request. If the result
    // write later fails, the row stays `sending` and cannot be reclaimed.
    if (!(await beginNotificationSend(db, claimId, ownerId))) {
      continue;
    }

    let sendPromise: Promise<SyncNotifierSendResult> | null = null;
    let outcome: NormalizedNotifierSend;
    try {
      sendPromise = notifier.send(input);
      outcome = normalizeNotifierSend(await withTimeout(sendPromise, timeoutMs, 'notifier.send'));
    } catch (error) {
      if (sendPromise !== null) observeLateNotificationSuccess(db, sendPromise, claimId, ownerId);
      await markNotificationClaimUncertain(db, claimId, ownerId, error);
      continue;
    }

    if (outcome.kind === 'uncertain') {
      await markNotificationClaimUncertain(
        db,
        claimId,
        ownerId,
        new Error('Discord delivery result could not be confirmed'),
      );
      continue;
    }
    if (outcome.kind === 'skipped' || outcome.kind === 'failed') {
      // These outcomes prove no message exists, so a later run may retry.
      await markNotificationClaimFailed(
        db,
        claimId,
        ownerId,
        new Error(('reason' in outcome ? outcome.reason : undefined) ?? `Notifier reported ${outcome.kind}`),
      );
      continue;
    }
    const update = await db
      .from('notifications')
      .update({
        delivery_status: 'sent',
        discord_message_id: outcome.messageId,
        delivered_at: new Date().toISOString(),
        delivery_reason: null,
        lease_until: null,
      })
      .eq('id', claimId)
      .eq('delivery_owner', ownerId)
      .eq('delivery_status', 'sending')
      .select('id');
    requireOk(update.error, 'Update notification claim');
    if (!Array.isArray(update.data) || update.data.length !== 1) {
      throw new Error('Notification claim was lost before recording delivery');
    }
    sent += 1;
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
  /** Re-run a completed period instead of returning the existing completed result. */
  force?: boolean;
  /** Testable override for the lock heartbeat interval. */
  lockRenewalIntervalMs?: number;
  /** Stable per-run notification owner; generated when absent. */
  notificationOwnerId?: string;
  /** Called as soon as the sync lock is proven lost. */
  onLockLost?: (reason: string) => void;
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

/**
 * Legacy unscoped entry point. Never build one roster across guilds: discover
 * guilds, sync each one in its own scope, then present a combined result.
 */
async function runSyncWithoutGuild(options: RunSyncOptions): Promise<SyncResult> {
  const results = await runSyncForAllGuilds(options);
  const first = results[0];
  if (first === undefined) return skippedResult('', 'No clubs registered');
  if (results.length === 1) return first;

  const sum = (select: (result: SyncResult) => number): number =>
    results.reduce((total, result) => total + select(result), 0);
  const failed = results.filter((result) => result.status === 'failed');
  const errors = failed
    .map((result) => result.error)
    .filter((error): error is string => typeof error === 'string' && error.length > 0)
    .join('; ');

  return {
    syncRunId: results.find((result) => result.syncRunId.length > 0)?.syncRunId ?? '',
    status:
      failed.length > 0
        ? 'failed'
        : results.every((result) => result.status === 'skipped')
          ? 'skipped'
          : 'completed',
    clubsProcessed: sum((result) => result.clubsProcessed),
    playersUpserted: sum((result) => result.playersUpserted),
    snapshotsWritten: sum((result) => result.snapshotsWritten),
    membershipEvents: sum((result) => result.membershipEvents),
    notificationsSent: sum((result) => result.notificationsSent),
    battlesCollected: sum((result) => result.battlesCollected),
    error: errors.length > 0 ? errors : undefined,
    affectedClubIds: [...new Set(results.flatMap((result) => result.affectedClubIds))],
    membersExpected: sum((result) => result.membersExpected ?? 0),
    membersSucceeded: sum((result) => result.membersSucceeded ?? 0),
    memberFailures: results.flatMap((result) => result.memberFailures ?? []),
    profileRefreshEnabled: results.some((result) => result.profileRefreshEnabled === true),
    lastSuccessfulProfileRefreshAt: (() => {
      const times = results
        .map((result) => result.lastSuccessfulProfileRefreshAt)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .sort();
      return times.length > 0 ? times[times.length - 1] : null;
    })(),
  };
}

export async function runSync(options: RunSyncOptions = {}): Promise<SyncResult> {
  const topLevelGuildId = options.guildId?.trim();
  if (topLevelGuildId === undefined || topLevelGuildId.length === 0) {
    return runSyncWithoutGuild(options);
  }

  let now: Date;
  let nowIso: string;
  let db: SupabaseClient;
  let apiClient: BrawlStarsClient;
  try {
    now = options?.now ?? new Date();
    nowIso = now.toISOString();
    db = createTrustedClient();
    apiClient = options?.client ?? getSharedBrawlStarsClient();
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
      ...guildContext(options.guildId?.trim()),
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
      ...guildContext(requestedGuildId),
    };
  }

  if (clubRows.length === 0) {
    return skippedResult(
      '',
      requestedGuildId !== undefined && requestedGuildId.length > 0
        ? 'No clubs registered for this server'
        : 'No clubs registered',
      requestedGuildId,
    );
  }

  const clubIds = clubRows.map((club) => club.id);
  const clubTags = clubRows.map((club) => club.tag);
  const clubNames = new Map(clubRows.map((club) => [club.id, club.name]));

  let runId: string | undefined;
  let affectedColumns = true;
  const counters = emptyCounters();
  let memberCounts: {
    membersExpected: number;
    membersSucceeded: number;
    memberFailures: readonly SyncMemberFailure[];
  } = { membersExpected: 0, membersSucceeded: 0, memberFailures: [] };
  let profileRefreshEnabled = true;
  let lastSuccessfulProfileRefreshAt: string | null = null;
  const lockToken = randomUUID();
  const notificationOwnerId = options.notificationOwnerId ?? randomUUID();
  let lockHeld = false;
  let lockRenewal: SyncLockRenewal | undefined;

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
        ...guildContext(requestedGuildId),
      };
    }
    if (!lockHeld) {
      return skippedResult('', 'Another sync process holds the database lock', requestedGuildId);
    }
    lockRenewal = startSyncLockRenewal(
      db,
      scope,
      lockToken,
      options?.lockRenewalIntervalMs ?? SYNC_LOCK_RENEW_INTERVAL_MS,
      options.onLockLost,
    );
    const assertOwnership = async (phase: string): Promise<void> => {
      if (lockRenewal === undefined || lockRenewal.lost || lockRenewal.signal.aborted) {
        throw new Error(`Sync lock lost before ${phase}; aborting run`);
      }
      const check = await db.rpc('assert_sync_lock_ownership', {
        p_scope: scope,
        p_token: lockToken,
      });
      requireOk(check.error, `Assert sync lock ownership (${phase})`);
      if (check.data !== true) {
        const reason = `Sync lock ownership lost before ${phase}`;
        lockRenewal.reportLoss(reason);
        throw new Error(reason);
      }
    };

    const acquired = await acquireRun(
      db,
      scope,
      periodStartIso,
      nowIso,
      nowMs,
      clubIds,
      clubTags,
      options.force === true,
    );
    if (acquired.kind === 'skip') {
      return { ...acquired.result, ...guildContext(requestedGuildId) };
    }
    runId = acquired.runId;
    const activeRunId = runId;
    affectedColumns = acquired.affectedColumns;

    // 1. Fetch everything before mutating any temporal state. A single API
    //    failure aborts the whole run; partial rosters are never persisted.
    //    Independent clubs are fetched concurrently, but no writes start until
    //    every roster has been validated.
    const fetched = await mapWithConcurrency(
      clubRows,
      SYNC_FETCH_CONCURRENCY,
      (row) => fetchClubData(apiClient, row, apiTimeoutMs),
      lockRenewal.signal,
    );
    counters.clubsProcessed = fetched.length;
    await assertOwnership('player writes');
    const memberCountsById = new Map(fetched.map((club) => [club.row.id, club.memberCount]));

    const roster = buildGlobalRoster(fetched);

    // 2. Players. A failed optional profile fetch is recorded for operator
    // notifications; roster identity still comes from the official club API.
    // Profile reads and idempotent player upserts are independent per player.
    const collectPlayerProfiles = readBooleanEnv('SYNC_COLLECT_PLAYER_PROFILES', true);
    profileRefreshEnabled = collectPlayerProfiles;
    const rosterEntries = [...roster.values()];
    const profileResults = await mapWithConcurrency(
      rosterEntries,
      SYNC_FETCH_CONCURRENCY,
      async (entry) => {
        if (!collectPlayerProfiles) return { profile: undefined, failure: null };
        let failure: string | null = null;
        const profile = await fetchPlayerProfile(apiClient, entry.tag, apiTimeoutMs, (reason) => {
          failure = reason;
        });
        return { profile, failure };
      },
      lockRenewal.signal,
    );
    const memberFailures: SyncMemberFailure[] = profileResults.flatMap((result, index) => {
      const entry = rosterEntries[index]!;
      return result.failure === null
        ? []
        : [{ tag: entry.tag, name: entry.name, reason: result.failure }];
    });
    await assertOwnership('player upserts');
    const states = await mapWithConcurrency(
      rosterEntries,
      SYNC_WRITE_CONCURRENCY,
      async (entry, index) => {
        const playerId = await upsertPlayer(
          db,
          apiClient,
          entry,
          nowIso,
          apiTimeoutMs,
          profileResults[index]?.profile,
          () => assertOwnership(`player upsert for ${entry.tag}`),
        );
        counters.playersUpserted += 1;
        return { ...entry, playerId };
      },
      lockRenewal.signal,
    );
    await assertOwnership('membership writes');
    memberCounts = {
      membersExpected: roster.size,
      membersSucceeded: Math.max(0, roster.size - memberFailures.length),
      memberFailures,
    };
    lastSuccessfulProfileRefreshAt =
      collectPlayerProfiles && memberCounts.membersSucceeded > 0 ? nowIso : null;
    log.info('Player profile refresh summary', {
      syncRunId: runId,
      guildId: requestedGuildId ?? null,
      phase: 'profile-refresh-summary',
      profileRefreshEnabled: collectPlayerProfiles,
      profilesExpected: memberCounts.membersExpected,
      profilesSucceeded: memberCounts.membersSucceeded,
      profileFailureCount: memberFailures.length,
      failedTags: memberFailures.slice(0, 20).map((failure) => failure.tag),
      lastSuccessfulProfileRefreshAt,
    });
    const presentPlayerIds = new Set(states.map((state) => state.playerId));

    // 3. Joins, transfers and same-club role changes, computed against the
    //    synced guild roster. Open memberships are scoped to the clubs being
    //    synced: another guild can independently track the same player in its
    //    own club row. Each event + membership change is committed atomically
    //    by Postgres.
    const openRowsBefore = await readOpenMembershipsForClubs(db, clubIds);
    const openByPlayer = new Map<string, OpenMembershipRow[]>();
    for (const row of openRowsBefore) {
      const rows = openByPlayer.get(row.player_id) ?? [];
      rows.push(row);
      openByPlayer.set(row.player_id, rows);
    }
    for (const state of states) {
      const scopedOpen = openByPlayer.get(state.playerId) ?? [];
      if (scopedOpen.length > 1) {
        throw new Error(
          `Player ${state.tag} has multiple open memberships in this sync scope; refusing to guess which one to close`,
        );
      }
      const open = scopedOpen[0];
      if (open !== undefined && open.club_id === state.clubId) {
        const fromRole = normalizeRole(open.role);
        const toRole = normalizeRole(state.role);
        if (fromRole !== toRole) {
          await assertOwnership(`role change for ${state.tag}`);
          await applyClubRoleChange(db, {
            clubId: state.clubId,
            playerId: state.playerId,
            membershipId: open.id,
            fromRole,
            toRole,
            detectedAt: nowIso,
            runId,
            guildId: requestedGuildId ?? '',
            lockScope: scope,
            lockToken,
          });
          counters.roleChanges += 1;
        }
        continue;
      }
      const eventType: EventType = open === undefined ? 'join' : 'transfer';
      await assertOwnership(`${eventType} write for ${state.tag}`);
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
        guildId: requestedGuildId ?? '',
        lockScope: scope,
        lockToken,
      });
      counters.membershipEvents += 1;
    }

    // 4. Leaves for open memberships in this scope absent from the synced roster.
    const openMemberships = await readOpenMembershipsForClubs(db, clubIds);
    for (const open of openMemberships) {
      if (presentPlayerIds.has(open.player_id)) {
        continue;
      }
      await assertOwnership(`leave write for ${open.player_id}`);
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
        guildId: requestedGuildId ?? '',
        lockScope: scope,
        lockToken,
      });
      counters.membershipEvents += 1;
    }

    // Notifications are derived from persisted events, not from the live
    // membership state or the current run id. An event committed by a run that
    // later failed is still announced by a later sync unless it was already
    // claimed in the notifications ledger.
    await assertOwnership('notification discovery');
    const recentEvents = await readPendingEvents(
      db,
      requestedGuildId ?? '',
      clubIds,
      nowIso,
      notificationOwnerId,
    );
    const pendingNotifications: SyncNotificationInput[] = recentEvents
      .map((event) => {
        const fromClubId = event.from_club_id ?? undefined;
        const toClubId = event.to_club_id ?? undefined;
        const fallbackNames = new Map<string, string>();
        const fromName = event.from_club?.name;
        const toName = event.to_club?.name;
        if (fromClubId !== undefined && typeof fromName === 'string') {
          fallbackNames.set(fromClubId, fromName);
        }
        if (toClubId !== undefined && typeof toName === 'string') {
          fallbackNames.set(toClubId, toName);
        }
        const tag = event.player?.tag;
        const name = event.player?.name;
        const relevantClubId = toClubId ?? fromClubId;
        const remainingMembers =
          relevantClubId === undefined ? undefined : memberCountsById.get(relevantClubId);
        return buildNotification(
          event.id,
          event.event_type as EventType,
          {
            tag: typeof tag === 'string' ? tag : '',
            name: typeof name === 'string' ? name : '',
          },
          new Map([...fallbackNames, ...clubNames]),
          fromClubId,
          toClubId,
          event.detected_at,
          remainingMembers,
        );
      })
      .slice(0, MAX_NOTIFICATIONS_PER_SYNC);

    // 5. Capacity transitions and snapshots (snapshots are skipped when the
    //    payload digest is unchanged). Read the previous count before writing
    //    the new snapshot so the comparison uses stored history.
    await assertOwnership('snapshot writes');
    await mapWithConcurrency(
      fetched,
      SYNC_WRITE_CONCURRENCY,
      async (club) => {
        const previousCount = await readPreviousMemberCount(db, club.row.id);
        if (previousCount !== undefined) {
          const wasFull = previousCount >= CLUB_CAPACITY;
          const isFull = club.memberCount >= CLUB_CAPACITY;
          if (wasFull !== isFull) {
            await assertOwnership(`capacity event for ${club.row.tag}`);
            await recordCapacityEvent(db, {
              clubId: club.row.id,
              fromCount: previousCount,
              toCount: club.memberCount,
              isFull,
              detectedAt: nowIso,
              runId: activeRunId,
            });
            counters.capacityEvents += 1;
          }
        }
        const written = await writeSnapshot(
          db,
          {
            table: 'club_snapshots',
            entityColumn: 'club_id',
            entityId: club.row.id,
            runId: activeRunId,
            hash: club.hash,
            raw: club.rawClub,
            capturedAt: nowIso,
            extra: { trophies: club.trophies, member_count: club.memberCount },
          },
          () => assertOwnership(`club snapshot for ${club.row.tag}`),
        );
        if (written) {
          counters.snapshotsWritten += 1;
        }
      },
      lockRenewal.signal,
    );
    await mapWithConcurrency(
      states,
      SYNC_WRITE_CONCURRENCY,
      async (state) => {
        const written = await writeSnapshot(
          db,
          {
            table: 'player_snapshots',
            entityColumn: 'player_id',
            entityId: state.playerId,
            runId: activeRunId,
            hash: payloadHash(state.raw),
            raw: state.raw,
            capturedAt: nowIso,
            extra: { trophies: state.trophies },
          },
          () => assertOwnership(`player snapshot for ${state.tag}`),
        );
        if (written) {
          counters.snapshotsWritten += 1;
        }
      },
      lockRenewal.signal,
    );

    if (collectBattleLogsEnabled && states.length > 0 && runId !== undefined) {
      await assertOwnership('battle log collection');
      counters.battlesCollected = await collectBattleLogs(
        db,
        apiClient,
        states.map((state) => ({ playerId: state.playerId, tag: state.tag })),
        runId,
        apiTimeoutMs,
        {
          assertBeforeWrite: () => assertOwnership('battle log write'),
          fence: lockRenewal.signal,
        },
      );
      await assertOwnership('notification delivery');
    }

    // 6. Notifications (only when a notifier and a channel are available).
    if (options?.notifier !== undefined) {
      await assertOwnership('notification delivery');
      counters.notificationsSent = await sendNotifications(
        db,
        options.notifier,
        pendingNotifications,
        notifierTimeoutMs,
        notificationOwnerId,
      );
    }

    log.info('Role and capacity changes recorded', {
      syncRunId: runId,
      roleChanges: counters.roleChanges,
      capacityEvents: counters.capacityEvents,
    });

    await assertOwnership('run completion');
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
      ...guildContext(requestedGuildId),
      ...memberCounts,
      profileRefreshEnabled,
      lastSuccessfulProfileRefreshAt,
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
      ...guildContext(requestedGuildId),
      ...memberCounts,
      profileRefreshEnabled,
      lastSuccessfulProfileRefreshAt,
    };
  } finally {
    if (lockRenewal !== undefined) {
      await lockRenewal.stop();
    }
    if (lockHeld) {
      await releaseSyncLock(db, scope, lockToken);
    }
  }
}
