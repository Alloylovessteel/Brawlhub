import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { recordAdminAudit, AdminServiceError } from '../../admin/service';
import type { AdminActor } from '../../admin/types';
import { asNumber, asString, record, relationRecord, requireOk } from '../service';
import { cleanTag } from '../../discord/format';
import { isClubLogPeriod } from './page-view';
import type { ClubLogPeriod } from '../types';
import type {
  ClubLogConfig,
  ClubLogDelivery,
  ClubLogEvent,
  ClubLogEventKind,
  ClubLogGroup,
  ClubLogRow,
} from './types';

export type {
  ClubLogConfig,
  ClubLogDelivery,
  ClubLogEvent,
  ClubLogEventKind,
  ClubLogGroup,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const MAX_LOGS_PER_GUILD = 25;
const MAX_EVENTS_PER_LOG = 20;
/** Page size below PostgREST's max_rows (1000) for undelivered event scans. */
const EVENT_SCAN_PAGE_SIZE = 500;
const CLUB_CAPACITY = 30;
const EVENT_KINDS: readonly ClubLogEventKind[] = ['membership', 'role', 'capacity'];
/**
 * Pending digests are claimed with an invisible sentinel in the same ledger row.
 * Only pre-send stages can be reclaimed after this timeout. A `sending` claim
 * may already have reached Discord, so it must never be released automatically.
 */
const DIGEST_CLAIM_PREFIX = 'claim:';
/** A posted-but-unrecorded digest carries its Discord message ID so retry can edit it. */
const DIGEST_DELIVERED_PREFIX = 'claim-delivered:';
const DIGEST_CLAIM_STALE_MS = 10 * 60_000;
const INTEGER_FORMATTER = new Intl.NumberFormat('en-US');

export interface ClubLogServiceOptions {
  readonly db?: DatabaseClient;
}

function dbFor(options: ClubLogServiceOptions): DatabaseClient {
  return options.db ?? createTrustedClient();
}

function requireGuildId(guildId: string): string {
  const value = typeof guildId === 'string' ? guildId.trim() : '';
  if (value === '') {
    throw new AdminServiceError('invalid_guild', 'Club logs can only be managed from within a Discord server.');
  }
  return value;
}

function requireId(value: string, code: string, message: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === '') throw new AdminServiceError(code, message);
  return normalized;
}

function eventId(value: unknown): string | null {
  return asString(value);
}

function detectedAt(value: unknown): string | null {
  const text = asString(value);
  if (text === null || Number.isNaN(Date.parse(text))) return null;
  return text;
}

function playerFrom(value: unknown): {
  readonly tag: string | null;
  readonly name: string | null;
  readonly trophies: number | null;
} {
  const player = relationRecord(value);
  const rawTag = asString(player?.['tag']);
  return {
    tag: rawTag === null ? null : cleanTag(rawTag),
    name: asString(player?.['name']),
    trophies: asNumber(player?.['trophies']),
  };
}

function safeLabel(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<[@#&](?:!?\d+|everyone|here)>/gi, '')
    .replace(/[<@>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? fallback : cleaned.slice(0, 80);
}

function playerLabel(event: Pick<ClubLogEvent, 'playerTag' | 'playerName'>): string {
  return safeLabel(event.playerName, event.playerTag === null ? 'Unknown player' : `#${event.playerTag}`);
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  president: 'President',
  vicepresident: 'Vice-President',
  vice_president: 'Vice-President',
  senior: 'Senior',
  member: 'Member',
  rookie: 'Rookie',
  notmember: 'Not a member',
  not_member: 'Not a member',
};

function roleLabel(value: unknown): string {
  const text = asString(value);
  if (text === null) return 'none';
  const known = ROLE_LABELS[text.toLowerCase()];
  if (known !== undefined) return known;
  return text
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ') || 'none';
}

const ROLE_RANKS: Readonly<Record<string, number>> = {
  none: 0,
  notmember: 0,
  not_member: 0,
  rookie: 1,
  member: 2,
  senior: 3,
  vicepresident: 4,
  vice_president: 4,
  president: 5,
};

function roleRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const text = asString(value);
  if (text === null) return 0;
  return ROLE_RANKS[text.toLowerCase()] ?? 2;
}

function roleMovement(fromRole: unknown, toRole: unknown): 'promoted' | 'demoted' | 'updated' {
  const from = roleRank(fromRole);
  const to = roleRank(toRole);
  if (to > from) return 'promoted';
  if (to < from) return 'demoted';
  return 'updated';
}

function parseLogRows(
  rows: readonly RawClubLog[],
  clubs: ReadonlyMap<string, { readonly tag: string; readonly name: string }>,
  periodsByLog: ReadonlyMap<string, readonly ClubLogPeriod[]>,
): ClubLogRow[] {
  const logs: ClubLogRow[] = [];
  for (const row of rows) {
    const club = clubs.get(row.clubId);
    if (club === undefined) continue;
    logs.push({
      ...row,
      clubTag: club.tag,
      clubName: club.name,
      periods: periodsByLog.get(row.id) ?? ['today'],
    });
  }
  return logs;
}

async function readLogPeriods(
  guildId: string,
  logIds: readonly string[],
  db: DatabaseClient,
): Promise<Map<string, ClubLogPeriod[]>> {
  const periods = new Map<string, ClubLogPeriod[]>();
  if (logIds.length === 0) return periods;
  const result = await db
    .from('guild_club_log_periods')
    .select('log_id, period')
    .eq('guild_id', guildId)
    .in('log_id', [...logIds]);
  requireOk(result.error, 'Read club log periods');
  for (const item of result.data ?? []) {
    const row = record(item);
    const logId = eventId(row?.['log_id']);
    const period = asString(row?.['period']);
    if (logId === null || period === null || !isClubLogPeriod(period)) continue;
    const current = periods.get(logId) ?? [];
    if (!current.includes(period)) current.push(period);
    periods.set(logId, current);
  }
  for (const [logId, current] of periods) {
    periods.set(
      logId,
      (['today', 'week', 'season'] as const).filter((candidate) => current.includes(candidate)),
    );
  }
  return periods;
}

interface RawClubLog {
  readonly id: string;
  readonly guildId: string;
  readonly clubId: string;
  readonly channelId: string;
  readonly createdAt: string;
}

async function readRawClubLogs(guildId: string, db: DatabaseClient): Promise<RawClubLog[]> {
  const result = await db
    .from('guild_club_logs')
    .select('id, guild_id, club_id, channel_id, created_at')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });
  requireOk(result.error, 'Read club logs');
  const rows = Array.isArray(result.data) ? result.data : [];
  return rows.flatMap((item) => {
    const row = record(item);
    const id = eventId(row?.['id']);
    const rowGuildId = asString(row?.['guild_id']);
    const clubId = eventId(row?.['club_id']);
    const channelId = asString(row?.['channel_id']);
    if (
      id === null ||
      rowGuildId !== guildId ||
      clubId === null ||
      channelId === null
    ) {
      return [];
    }
    return [{
      id,
      guildId: rowGuildId,
      clubId,
      channelId,
      createdAt: detectedAt(row?.['created_at']) ?? new Date().toISOString(),
    }];
  });
}

/** List a guild's log subscriptions, including only active clubs owned by that guild. */
export async function loadClubLogRows(
  guildId: string,
  options: ClubLogServiceOptions = {},
): Promise<ClubLogRow[]> {
  const parsedGuildId = requireGuildId(guildId);
  const db = dbFor(options);
  const rawLogs = await readRawClubLogs(parsedGuildId, db);
  const clubIds = [...new Set(rawLogs.map((row) => row.clubId))];
  if (clubIds.length === 0) return [];

  const clubsResult = await db
    .from('clubs')
    .select('id, tag, name, guild_id, archived_at')
    .in('id', clubIds)
    .eq('guild_id', parsedGuildId)
    .is('archived_at', null);
  requireOk(clubsResult.error, 'Read clubs for club logs');

  const clubRows = Array.isArray(clubsResult.data) ? clubsResult.data : [];
  const clubs = new Map<string, { readonly tag: string; readonly name: string }>();
  for (const item of clubRows) {
    const row = record(item);
    const id = eventId(row?.['id']);
    const tag = asString(row?.['tag']);
    const name = asString(row?.['name']);
    const clubGuildId = asString(row?.['guild_id']);
    const archivedAt = row?.['archived_at'];
    if (
      id === null ||
      tag === null ||
      name === null ||
      clubGuildId !== parsedGuildId ||
      (archivedAt !== null && archivedAt !== undefined)
    ) {
      continue;
    }
    clubs.set(id, { tag, name });
  }

  const periodsByLog = await readLogPeriods(
    parsedGuildId,
    [...new Set(rawLogs.map((row) => row.id))],
    db,
  );
  return parseLogRows(rawLogs, clubs, periodsByLog).sort(
    (left, right) =>
      left.clubName.localeCompare(right.clubName) ||
      left.clubTag.localeCompare(right.clubTag) ||
      left.id.localeCompare(right.id),
  );
}

/** Public, guild-scoped view of configured club logs. */
export async function loadClubLogs(
  guildId: string,
  options: ClubLogServiceOptions = {},
): Promise<ClubLogConfig[]> {
  const rows = await loadClubLogRows(guildId, options);
  return rows.map(({ createdAt: _createdAt, ...config }) => config);
}

/** Subscribe one active guild club to a text channel and trophy period. */
export async function addClubLog(
  input: {
    readonly actor: AdminActor;
    readonly guildId: string;
    readonly clubId: string;
    readonly channelId: string;
    readonly period?: string | null;
  },
  options: ClubLogServiceOptions = {},
): Promise<ClubLogConfig[]> {
  const guildId = requireGuildId(input.guildId);
  const clubId = requireId(input.clubId, 'invalid_club', 'Choose a registered club from the list.');
  const channelId = requireId(
    input.channelId,
    'invalid_channel',
    'Choose a text channel for these club logs.',
  );
  const rawPeriod = input.period ?? 'today';
  if (!isClubLogPeriod(rawPeriod)) {
    throw new AdminServiceError('invalid_period', 'Choose a valid club log period.');
  }
  const period: ClubLogPeriod = rawPeriod;
  const db = dbFor(options);

  const clubResult = await db
    .from('clubs')
    .select('id, tag, name, guild_id')
    .eq('id', clubId)
    .eq('guild_id', guildId)
    .is('archived_at', null)
    .maybeSingle();
  requireOk(clubResult.error, 'Validate club log club');
  const clubRow = record(clubResult.data);
  const clubArchivedAt = clubRow?.['archived_at'];
  if (
    clubRow === null ||
    asString(clubRow['guild_id']) !== guildId ||
    (clubArchivedAt !== null && clubArchivedAt !== undefined)
  ) {
    throw new AdminServiceError('invalid_club', 'That club is not active and registered in this server.');
  }

  const existingRows = await readRawClubLogs(guildId, db);
  const duplicate = existingRows.some(
    (row) => row.clubId === clubId && row.channelId === channelId,
  );
  if (!duplicate && existingRows.length >= MAX_LOGS_PER_GUILD) {
    throw new AdminServiceError(
      'log_limit',
      `This server can configure at most ${MAX_LOGS_PER_GUILD} club logs.`,
    );
  }

  const saved = await db.from('guild_club_logs').upsert(
    {
      guild_id: guildId,
      club_id: clubId,
      channel_id: channelId,
      created_by: input.actor.profileId,
    },
    {
      onConflict: 'guild_id,club_id,channel_id',
      ignoreDuplicates: true,
    },
  );
  requireOk(saved.error, 'Save club log');

  const savedRows = await readRawClubLogs(guildId, db);
  const savedRow = savedRows.find(
    (row) => row.clubId === clubId && row.channelId === channelId,
  );
  if (savedRow === undefined) {
    throw new AdminServiceError('save_failed', 'Could not save that club log.');
  }

  const savedPeriod = await db.from('guild_club_log_periods').upsert(
    {
      guild_id: guildId,
      log_id: savedRow.id,
      period,
    },
    {
      onConflict: 'guild_id,log_id,period',
      ignoreDuplicates: true,
    },
  );
  requireOk(savedPeriod.error, 'Save club log period');

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'club_log.added',
      targetType: 'club',
      targetId: clubId,
      guildId,
      details: { guildId, clubId, channelId, period },
    },
    { db },
  );

  return loadClubLogs(guildId, { db });
}

/** Remove a trophy period from a club log, or all log subscriptions when no period is given. */
export async function removeClubLog(
  input: {
    readonly actor: AdminActor;
    readonly guildId: string;
    readonly clubId: string;
    readonly period?: string | null;
  },
  options: ClubLogServiceOptions = {},
): Promise<ClubLogConfig[]> {
  const guildId = requireGuildId(input.guildId);
  const clubId = requireId(input.clubId, 'invalid_club', 'Choose a registered club from the list.');
  const rawPeriod = input.period ?? null;
  if (rawPeriod !== null && !isClubLogPeriod(rawPeriod)) {
    throw new AdminServiceError('invalid_period', 'Choose a valid club log period.');
  }
  const db = dbFor(options);
  let removed = 0;

  if (rawPeriod !== null) {
    const targetLogs = (await readRawClubLogs(guildId, db)).filter((row) => row.clubId === clubId);
    if (targetLogs.length === 0) {
      throw new AdminServiceError('not_found', 'That club has no logs configured in this server.');
    }
    const logIds = targetLogs.map((row) => row.id);
    const deletedPeriods = await db
      .from('guild_club_log_periods')
      .delete()
      .eq('guild_id', guildId)
      .eq('period', rawPeriod)
      .in('log_id', logIds)
      .select('log_id');
    requireOk(deletedPeriods.error, 'Remove club log period');
    if ((deletedPeriods.data ?? []).length === 0) {
      throw new AdminServiceError('not_found', 'That club log does not use the selected period.');
    }

    const remaining = await db
      .from('guild_club_log_periods')
      .select('log_id')
      .eq('guild_id', guildId)
      .in('log_id', logIds);
    requireOk(remaining.error, 'Read remaining club log periods');
    const remainingIds = new Set(
      (remaining.data ?? [])
        .map((item) => eventId(record(item)?.['log_id']))
        .filter((id): id is string => id !== null),
    );
    const emptyLogIds = logIds.filter((id) => !remainingIds.has(id));
    if (emptyLogIds.length > 0) {
      const removedLogs = await db
        .from('guild_club_logs')
        .delete()
        .eq('guild_id', guildId)
        .eq('club_id', clubId)
        .in('id', emptyLogIds)
        .select('id');
      requireOk(removedLogs.error, 'Remove empty club log');
      removed = (removedLogs.data ?? []).length;
    }
  } else {
    const removedLogs = await db
      .from('guild_club_logs')
      .delete()
      .eq('guild_id', guildId)
      .eq('club_id', clubId)
      .select('id');
    requireOk(removedLogs.error, 'Remove club log');
    removed = (removedLogs.data ?? []).length;
    if (removed === 0) {
      throw new AdminServiceError('not_found', 'That club has no logs configured in this server.');
    }
  }

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'club_log.removed',
      targetType: 'club',
      targetId: clubId,
      guildId,
      details: { guildId, clubId, ...(rawPeriod === null ? {} : { period: rawPeriod }), removed },
    },
    { db },
  );

  return loadClubLogs(guildId, { db });
}

/** All guild IDs with at least one log subscription (metadata only, no club content). */
export async function readClubLogGuildIds(
  options: ClubLogServiceOptions = {},
): Promise<string[]> {
  const db = dbFor(options);
  const result = await db.from('guild_club_logs').select('guild_id');
  requireOk(result.error, 'Read club log guilds');
  const ids = (result.data ?? [])
    .map((item) => asString(record(item)?.['guild_id']))
    .filter((id): id is string => id !== null);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/** Only ask the ledger about candidate keys actually seen in an event page. */
async function readDeliveredKeys(
  guildId: string,
  logId: string,
  period: ClubLogPeriod,
  candidateKeys: readonly { readonly kind: ClubLogEventKind; readonly id: string }[],
  db: DatabaseClient,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (candidateKeys.length === 0) return keys;
  const result = await db.rpc('club_log_delivered_keys', {
    p_guild_id: guildId,
    p_log_id: logId,
    p_period: period,
    p_candidate_keys: candidateKeys.map((key) => ({ kind: key.kind, id: key.id })),
    p_limit: EVENT_SCAN_PAGE_SIZE,
  });
  requireOk(result.error, 'Read club log deliveries');
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const row = record(item);
    const kind = asString(row?.['event_kind']);
    const id = eventId(row?.['event_id']);
    if (id === null || kind === null) continue;
    if (EVENT_KINDS.some((candidate) => candidate === kind)) keys.add(`${kind}:${id}`);
  }
  return keys;
}

function parseMembershipEvent(
  value: unknown,
  log: ClubLogRow,
): ClubLogEvent | null {
  const row = record(value);
  if (row === null) return null;
  const id = eventId(row['id']);
  const at = detectedAt(row['detected_at']);
  const eventType = asString(row['event_type']);
  if (id === null || at === null) return null;
  if (eventType !== 'join' && eventType !== 'leave' && eventType !== 'transfer') return null;

  const fromClubId = eventId(row['from_club_id']);
  const toClubId = eventId(row['to_club_id']);
  const player = playerFrom(row['player']);
  const label = playerLabel({ playerTag: player.tag, playerName: player.name });
  const clubName = safeLabel(log.clubName, `#${cleanTag(log.clubTag)}`);

  let description: string | null = null;
  if (eventType === 'join' && toClubId === log.clubId) {
    description = `${label} joined ${clubName}`;
  } else if (eventType === 'leave' && fromClubId === log.clubId) {
    description = `${label} left ${clubName}`;
  } else if (eventType === 'transfer' && fromClubId === log.clubId && toClubId === log.clubId) {
    description = `${label} transferred within ${clubName}`;
  } else if (eventType === 'transfer' && fromClubId === log.clubId) {
    description = `${label} transferred from ${clubName} to another club`;
  } else if (eventType === 'transfer' && toClubId === log.clubId) {
    description = `${label} transferred from another club to ${clubName}`;
  }
  if (description === null) return null;

  return {
    kind: 'membership',
    id,
    clubId: log.clubId,
    playerTag: player.tag,
    playerName: player.name,
    description,
    detectedAt: at,
  };
}

function parseRoleEvent(value: unknown, log: ClubLogRow): ClubLogEvent | null {
  const row = record(value);
  if (row === null) return null;
  const id = eventId(row['id']);
  const at = detectedAt(row['detected_at']);
  if (id === null || at === null) return null;
  const player = playerFrom(row['player']);
  const name = player.name ?? (player.tag === null ? 'Unknown player' : `#${player.tag}`);
  const label =
    player.trophies === null
      ? name
      : `${name} (${INTEGER_FORMATTER.format(player.trophies)} 🏆)`;
  const movement = roleMovement(row['from_role'], row['to_role']);
  return {
    kind: 'role',
    id,
    clubId: log.clubId,
    playerTag: player.tag,
    playerName: player.name,
    description: `${label} was ${movement} to ${roleLabel(row['to_role'])}.`,
    detectedAt: at,
  };
}

function parseCapacityEvent(value: unknown, log: ClubLogRow): ClubLogEvent | null {
  const row = record(value);
  if (row === null) return null;
  const id = eventId(row['id']);
  const at = detectedAt(row['detected_at']);
  const count = asNumber(row['to_count']);
  const isFull = row['is_full'] === true;
  if (id === null || at === null || count === null) return null;
  return {
    kind: 'capacity',
    id,
    clubId: log.clubId,
    playerTag: null,
    playerName: null,
    description: isFull
      ? `Club full (${count}/${CLUB_CAPACITY})`
      : `Club open (${count}/${CLUB_CAPACITY})`,
    detectedAt: at,
  };
}

type EventPageFetcher = (
  from: number,
  to: number,
) => PromiseLike<{
  readonly data: unknown;
  readonly error: { readonly message?: string } | null;
}>;

type DeliveredKeyFetcher = (
  candidateKeys: readonly { readonly kind: ClubLogEventKind; readonly id: string }[],
) => PromiseLike<ReadonlySet<string>>;

/**
 * Scan newest-first pages until enough rows outside the delivery ledger are
 * found. Each page is checked against a bounded, candidate-key-only ledger RPC,
 * so an old row beyond the REST cap can never masquerade as undelivered.
 */
async function readUndeliveredEventRows(
  fetchPage: EventPageFetcher,
  fetchDelivered: DeliveredKeyFetcher,
  kind: ClubLogEventKind,
): Promise<unknown[]> {
  const found: unknown[] = [];
  let offset = 0;
  for (;;) {
    const result = await fetchPage(offset, offset + EVENT_SCAN_PAGE_SIZE - 1);
    requireOk(result.error, `Read club log ${kind} events`);
    const rows = Array.isArray(result.data) ? result.data : [];
    const candidates = new Map<string, { readonly kind: ClubLogEventKind; readonly id: string }>();
    for (const row of rows) {
      const id = eventId(record(row)?.['id']);
      if (id !== null) candidates.set(`${kind}:${id}`, { kind, id });
    }
    const delivered = await fetchDelivered([...candidates.values()]);
    for (const row of rows) {
      const id = eventId(record(row)?.['id']);
      if (id === null || !delivered.has(`${kind}:${id}`)) found.push(row);
    }
    if (rows.length < EVENT_SCAN_PAGE_SIZE || found.length >= MAX_EVENTS_PER_LOG) break;
    offset += rows.length;
  }
  return found
    .sort((left, right) => {
      const leftRow = record(left);
      const rightRow = record(right);
      const leftAt = detectedAt(leftRow?.['detected_at']) ?? '';
      const rightAt = detectedAt(rightRow?.['detected_at']) ?? '';
      return (
        rightAt.localeCompare(leftAt) ||
        (eventId(rightRow?.['id']) ?? '').localeCompare(eventId(leftRow?.['id']) ?? '')
      );
    })
    .slice(0, MAX_EVENTS_PER_LOG);
}

async function loadEventsForLog(
  guildId: string,
  log: ClubLogRow,
  db: DatabaseClient,
  period: ClubLogPeriod,
  onlyUndelivered = true,
): Promise<ClubLogEvent[]> {
  const fetchDelivered: DeliveredKeyFetcher = onlyUndelivered
    ? (candidateKeys) => readDeliveredKeys(guildId, log.id, period, candidateKeys, db)
    : async () => new Set<string>();

  // No subscription-time watermark: stored history is included so a newly added log
  // can backfill past joins, leaves, transfers, role and capacity changes. The
  // delivery ledger is applied while scanning pages, so undelivered events past
  // any single query window are still picked up on a later poll.
  const [membership, roles, capacity] = await Promise.all([
    readUndeliveredEventRows(
      (from, to) =>
        db
          .from('membership_events')
          .select(
            'id, event_type, detected_at, from_club_id, to_club_id, player:players!membership_events_player_id_fkey(tag, name)',
          )
          .or(`from_club_id.eq.${log.clubId},to_club_id.eq.${log.clubId}`)
          .order('detected_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      fetchDelivered,
      'membership',
    ),
    readUndeliveredEventRows(
      (from, to) =>
        db
          .from('club_role_changes')
          .select(
            'id, from_role, to_role, detected_at, player:players!club_role_changes_player_id_fkey(tag, name, trophies)',
          )
          .eq('club_id', log.clubId)
          .order('detected_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      fetchDelivered,
      'role',
    ),
    readUndeliveredEventRows(
      (from, to) =>
        db
          .from('club_capacity_events')
          .select('id, from_count, to_count, is_full, detected_at')
          .eq('club_id', log.clubId)
          .order('detected_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      fetchDelivered,
      'capacity',
    ),
  ]);

  const events: ClubLogEvent[] = [];
  for (const item of membership) {
    const event = parseMembershipEvent(item, log);
    if (event !== null) events.push(event);
  }
  for (const item of roles) {
    const event = parseRoleEvent(item, log);
    if (event !== null) events.push(event);
  }
  for (const item of capacity) {
    const event = parseCapacityEvent(item, log);
    if (event !== null) events.push(event);
  }

  return events
    .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt) || left.id.localeCompare(right.id))
    .slice(0, MAX_EVENTS_PER_LOG);
}

/**
 * Undelivered stored change events for every log subscription in one guild.
 * Membership/role changes are no longer tied to a trophy period: they post
 * once as their own event log. The existing `today` delivery key is retained
 * so those rows from the old per-period ledger are not reposted.
 * Every read is scoped to that guild and to the log's club.
 */
export async function loadUndeliveredClubLogEvents(
  guildId: string,
  options: ClubLogServiceOptions = {},
): Promise<ClubLogGroup[]> {
  const parsedGuildId = requireGuildId(guildId);
  const db = dbFor(options);
  const logs = await loadClubLogRows(parsedGuildId, { db });
  const groups: ClubLogGroup[] = [];
  for (const fullLog of logs) {
    const events = await loadEventsForLog(parsedGuildId, fullLog, db, 'today');
    if (events.length === 0) continue;
    const { createdAt: _createdAt, ...log } = fullLog;
    groups.push({ log, events });
  }
  return groups;
}

/**
 * Recent stored change events for one configured log, regardless of whether
 * they were already delivered by the scheduled poster. Used by previews.
 */
export async function loadRecentClubLogEvents(
  guildId: string,
  logId: string,
  options: ClubLogServiceOptions = {},
): Promise<ClubLogGroup[]> {
  const parsedGuildId = requireGuildId(guildId);
  const db = dbFor(options);
  const logs = await loadClubLogRows(parsedGuildId, { db });
  const log = logs.find((candidate) => candidate.id === logId);
  if (log === undefined) return [];
  const events = await loadEventsForLog(parsedGuildId, log, db, 'today', false);
  if (events.length === 0) return [];
  const { createdAt: _createdAt, ...config } = log;
  return [{ log: config, events }];
}

/** Record delivered event IDs so a retry never re-posts the same change. */
export async function markClubLogEventsDelivered(
  guildId: string,
  deliveries: readonly ClubLogDelivery[],
  options: ClubLogServiceOptions = {},
): Promise<void> {
  const parsedGuildId = requireGuildId(guildId);
  if (deliveries.length === 0) return;
  const db = dbFor(options);

  const allowedLogIds = new Set((await loadClubLogRows(parsedGuildId, { db })).map((log) => log.id));
  const rows = deliveries
    .filter((delivery) => allowedLogIds.has(delivery.logId))
    .map((delivery) => ({
      guild_id: parsedGuildId,
      log_id: delivery.logId,
      period: delivery.period,
      event_kind: delivery.kind,
      event_id: delivery.eventId,
    }));
  if (rows.length === 0) return;

  const saved = await db.from('guild_club_log_deliveries').upsert(rows, {
    onConflict: 'guild_id,log_id,period,event_kind,event_id',
    ignoreDuplicates: true,
  });
  requireOk(saved.error, 'Record club log deliveries');
}

/** One completed-window digest post, keyed by log and trophy period. */
export interface ClubLogDigestPost {
  readonly logId: string;
  readonly period: ClubLogPeriod;
  readonly periodKey: string;
  readonly channelId: string;
  readonly messageId: string;
}

/** The minimum information needed to claim one completed digest window. */
export interface ClubLogDigestClaimInput {
  readonly logId: string;
  readonly period: ClubLogPeriod;
  readonly periodKey: string;
  readonly channelId: string;
}

export type ClubLogDigestClaimStage = 'reserved' | 'loading' | 'sending';
type ClubLogDigestPreSendStage = Exclude<ClubLogDigestClaimStage, 'sending'>;

export interface ClubLogDigestClaimResult {
  /** Identifies this process's sentinels so failed posts can release only their own claims. */
  readonly claimId: string;
  /** Ledger keys this caller won; every other key is already owned by another poll. */
  readonly keys: ReadonlySet<string>;
}

export interface ClubLogDigestClaimOptions extends ClubLogServiceOptions {
  /** Clock used to reclaim abandoned pre-send claims in tests and scheduling code. */
  readonly now?: Date;
}

interface ParsedClubLogDigestClaim {
  readonly claimId: string;
  readonly stage: ClubLogDigestClaimStage | 'legacy';
}

function digestKey(logId: string, period: ClubLogPeriod, periodKey: string): string {
  return `${logId}:${period}:${periodKey}`;
}

function digestClaimMessageId(
  claimId: string,
  key: string,
  stage: ClubLogDigestClaimStage = 'reserved',
): string {
  return `${DIGEST_CLAIM_PREFIX}${claimId}:${stage}:${key}`;
}

function parseDigestClaim(messageId: string | null, key?: string): ParsedClubLogDigestClaim | null {
  if (messageId === null || !messageId.startsWith(DIGEST_CLAIM_PREFIX)) return null;
  const parts = messageId.slice(DIGEST_CLAIM_PREFIX.length).split(':');
  const claimId = parts[0];
  if (claimId === undefined || claimId === '') return null;
  const stage = parts[1];
  if (stage === 'reserved' || stage === 'loading' || stage === 'sending') {
    const parsedKey = parts.slice(2).join(':');
    if (key !== undefined && parsedKey !== key) return null;
    return { claimId, stage };
  }
  // Older claims carried no stage. They may have reached Discord, so they are
  // uncertain and cannot be reclaimed.
  const legacyKey = parts.slice(1).join(':');
  if (key !== undefined && legacyKey !== key) return null;
  return { claimId, stage: 'legacy' };
}

function digestDeliveredMessageId(
  claimId: string,
  periodKey: string,
  messageId: string,
): string {
  return `${DIGEST_DELIVERED_PREFIX}${claimId}:${periodKey}:${messageId}`;
}

function isDigestSentinel(messageId: string | null): boolean {
  return (
    messageId !== null &&
    (messageId.startsWith(DIGEST_CLAIM_PREFIX) || messageId.startsWith(DIGEST_DELIVERED_PREFIX))
  );
}

function parseDigestDeliveredMessageId(value: string | null): {
  readonly claimId: string;
  readonly periodKey: string;
  readonly messageId: string;
} | null {
  if (value === null || !value.startsWith(DIGEST_DELIVERED_PREFIX)) return null;
  const parts = value.slice(DIGEST_DELIVERED_PREFIX.length).split(':');
  if (parts.length < 3) return null;
  const [claimId, periodKey, ...messageParts] = parts;
  const messageId = messageParts.join(':');
  if (
    claimId === undefined || claimId === '' ||
    periodKey === undefined || periodKey === '' ||
    messageId === ''
  ) {
    return null;
  }
  return { claimId, periodKey, messageId };
}

/**
 * Turn a posted-but-unrecorded sentinel back into a normal ledger row before
 * any new claims are made. Only sentinels that carry a Discord message ID can
 * be recovered; an ID-less sentinel is uncertain and stays untouched.
 */
async function reconcileDeliveredDigestClaims(
  guildId: string,
  db: DatabaseClient,
): Promise<void> {
  const result = await db
    .from('guild_club_log_digest_posts')
    .select('log_id, period, period_key, channel_id, message_id')
    .eq('guild_id', guildId)
    .like('message_id', `${DIGEST_DELIVERED_PREFIX}%`);
  requireOk(result.error, 'Read delivered club log digest claims');

  const rows: Array<Record<string, unknown>> = [];
  for (const item of result.data ?? []) {
    const row = record(item);
    const parsed = parseDigestDeliveredMessageId(asString(row?.['message_id']));
    const logId = eventId(row?.['log_id']);
    const period = asString(row?.['period']);
    const periodKey = asString(row?.['period_key']);
    const channelId = asString(row?.['channel_id']);
    if (
      parsed === null || logId === null || period === null ||
      !isClubLogPeriod(period) || periodKey === null || channelId === null ||
      parsed.periodKey !== periodKey
    ) {
      continue;
    }
    rows.push({
      guild_id: guildId,
      log_id: logId,
      period,
      period_key: periodKey,
      channel_id: channelId,
      message_id: parsed.messageId,
    });
  }
  if (rows.length === 0) return;

  const saved = await db.from('guild_club_log_digest_posts').upsert(rows, {
    onConflict: 'guild_id,log_id,period,period_key',
    ignoreDuplicates: false,
  });
  requireOk(saved.error, 'Recover club log digest post');
}

/**
 * Take over only abandoned pre-send claims. `sending` and unstaged legacy
 * claims may already have reached Discord, so they stay untouched forever.
 */
async function recoverStaleDigestClaims(
  guildId: string,
  wantedKeys: ReadonlySet<string>,
  claimId: string,
  db: DatabaseClient,
  staleBeforeMs: number,
): Promise<Set<string>> {
  if (wantedKeys.size === 0) return new Set();
  const result = await db
    .from('guild_club_log_digest_posts')
    .select('log_id, period, period_key, message_id, created_at')
    .eq('guild_id', guildId)
    .like('message_id', `${DIGEST_CLAIM_PREFIX}%`);
  requireOk(result.error, 'Read stale club log digest claims');

  const recovered = new Set<string>();
  for (const item of result.data ?? []) {
    const row = record(item);
    const logId = eventId(row?.['log_id']);
    const period = asString(row?.['period']);
    const periodKey = asString(row?.['period_key']);
    const messageId = asString(row?.['message_id']);
    const createdAt = asString(row?.['created_at']);
    if (
      logId === null || period === null || !isClubLogPeriod(period) || periodKey === null ||
      messageId === null || createdAt === null
    ) {
      continue;
    }
    const key = digestKey(logId, period, periodKey);
    if (!wantedKeys.has(key)) continue;
    const claim = parseDigestClaim(messageId, key);
    if (claim === null || (claim.stage !== 'reserved' && claim.stage !== 'loading')) continue;
    const createdMs = Date.parse(createdAt);
    if (Number.isNaN(createdMs) || createdMs >= staleBeforeMs) continue;

    const takeoverId = digestClaimMessageId(claimId, key, 'reserved');
    const updated = await db
      .from('guild_club_log_digest_posts')
      .update({ message_id: takeoverId })
      .eq('guild_id', guildId)
      .eq('message_id', messageId)
      .select('message_id');
    requireOk(updated.error, 'Recover club log digest claim');
    if ((updated.data ?? []).some((candidate) => asString(record(candidate)?.['message_id']) === takeoverId)) {
      recovered.add(key);
    }
  }
  return recovered;
}

/**
 * Atomically claim the completed windows this poll may post. Duplicate-key
 * inserts lose silently, so only one worker ever wins a given ledger key.
 * Sentinels are deliberately invisible to `readPostedClubLogDigests`.
 */
export async function claimClubLogDigestWindows(
  guildId: string,
  windows: readonly ClubLogDigestClaimInput[],
  options: ClubLogDigestClaimOptions = {},
): Promise<ClubLogDigestClaimResult> {
  const parsedGuildId = requireGuildId(guildId);
  if (windows.length === 0) return { claimId: '', keys: new Set() };
  const db = dbFor(options);

  const now = options.now;
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const staleBeforeMs = nowMs - DIGEST_CLAIM_STALE_MS;
  const claimId = randomUUID();
  // Reconciliation must precede claiming: a recovered row then blocks a fresh
  // claim by duplicate key, so a live message is never posted twice.
  await reconcileDeliveredDigestClaims(parsedGuildId, db);

  const allowedLogIds = new Set((await loadClubLogRows(parsedGuildId, { db })).map((log) => log.id));
  const unique = new Map<string, ClubLogDigestClaimInput>();
  for (const window of windows) {
    if (!allowedLogIds.has(window.logId)) continue;
    unique.set(digestKey(window.logId, window.period, window.periodKey), window);
  }
  if (unique.size === 0) return { claimId: '', keys: new Set() };

  const recovered = await recoverStaleDigestClaims(
    parsedGuildId,
    new Set(unique.keys()),
    claimId,
    db,
    staleBeforeMs,
  );
  const rows = [...unique]
    .filter(([key]) => !recovered.has(key))
    .map(([key, window]) => ({
      guild_id: parsedGuildId,
      log_id: window.logId,
      period: window.period,
      period_key: window.periodKey,
      channel_id: window.channelId,
      message_id: digestClaimMessageId(claimId, key, 'reserved'),
    }));
  if (rows.length === 0) return { claimId, keys: recovered };

  const inserted = await db
    .from('guild_club_log_digest_posts')
    .upsert(rows, {
      onConflict: 'guild_id,log_id,period,period_key',
      ignoreDuplicates: true,
    })
    .select('log_id, period, period_key, message_id');
  requireOk(inserted.error, 'Claim club log digest windows');

  for (const item of inserted.data ?? []) {
    const row = record(item);
    const logId = eventId(row?.['log_id']);
    const period = asString(row?.['period']);
    const periodKey = asString(row?.['period_key']);
    if (logId === null || period === null || !isClubLogPeriod(period) || periodKey === null) {
      continue;
    }
    const key = digestKey(logId, period, periodKey);
    if (asString(row?.['message_id']) !== digestClaimMessageId(claimId, key, 'reserved')) continue;
    recovered.add(key);
  }
  return { claimId, keys: recovered };
}

/** Advance one owned claim before rendering or before calling Discord. */
export async function advanceClubLogDigestClaim(
  guildId: string,
  claimId: string,
  key: string,
  from: ClubLogDigestPreSendStage,
  to: Exclude<ClubLogDigestClaimStage, 'reserved'>,
  options: ClubLogServiceOptions = {},
): Promise<boolean> {
  const parsedGuildId = requireGuildId(guildId);
  if (claimId === '') return false;
  const db = dbFor(options);
  const currentId = digestClaimMessageId(claimId, key, from);
  const nextId = digestClaimMessageId(claimId, key, to);
  const updated = await db
    .from('guild_club_log_digest_posts')
    .update({ message_id: nextId })
    .eq('guild_id', parsedGuildId)
    .eq('message_id', currentId)
    .select('message_id');
  requireOk(updated.error, 'Advance club log digest claim');
  return (updated.data ?? []).some((item) => asString(record(item)?.['message_id']) === nextId);
}

/**
 * Release only pre-send claims. A `sending` claim may already be live on
 * Discord, so it is never removed automatically.
 */
export async function releaseClubLogDigestClaims(
  guildId: string,
  claimId: string,
  keys: readonly string[],
  options: ClubLogServiceOptions = {},
): Promise<void> {
  const parsedGuildId = requireGuildId(guildId);
  if (claimId === '' || keys.length === 0) return;
  const db = dbFor(options);
  const messageIds = [...new Set(keys)].flatMap((key) => [
    digestClaimMessageId(claimId, key, 'reserved'),
    digestClaimMessageId(claimId, key, 'loading'),
  ]);
  const released = await db
    .from('guild_club_log_digest_posts')
    .delete()
    .eq('guild_id', parsedGuildId)
    .in('message_id', messageIds);
  requireOk(released.error, 'Release club log digest claims');
}

/**
 * Release one exact `sending` claim only after Discord definitively rejected a
 * replacement for a deleted digest message. Other stages, legacy claims and
 * uncertain outcomes are never removed automatically.
 */
export async function releaseClubLogDigestSendingClaimAfterRejectedReplacement(
  guildId: string,
  claimId: string,
  key: string,
  options: ClubLogServiceOptions = {},
): Promise<void> {
  const parsedGuildId = requireGuildId(guildId);
  if (claimId === '' || key === '') return;
  const released = await dbFor(options)
    .from('guild_club_log_digest_posts')
    .delete()
    .eq('guild_id', parsedGuildId)
    .eq('message_id', digestClaimMessageId(claimId, key, 'sending'));
  requireOk(released.error, 'Release rejected club log digest replacement claim');
}

/** Read which completed windows this guild already posted, for restart-safe polling. */
export async function readPostedClubLogDigests(
  guildId: string,
  options: ClubLogServiceOptions = {},
): Promise<Set<string>> {
  const parsedGuildId = requireGuildId(guildId);
  const db = dbFor(options);
  const result = await db
    .from('guild_club_log_digest_posts')
    .select('log_id, period, period_key, message_id')
    .eq('guild_id', parsedGuildId);
  requireOk(result.error, 'Read club log digest posts');
  const keys = new Set<string>();
  for (const item of result.data ?? []) {
    const row = record(item);
    const logId = eventId(row?.['log_id']);
    const period = asString(row?.['period']);
    const periodKey = asString(row?.['period_key']);
    if (isDigestSentinel(asString(row?.['message_id']))) continue;
    if (logId === null || period === null || !isClubLogPeriod(period) || periodKey === null) {
      continue;
    }
    keys.add(digestKey(logId, period, periodKey));
  }
  return keys;
}

/** Read delivered posts for one completed window so a digest can be edited in place. */
export async function loadPostedClubLogDigestPosts(
  guildId: string,
  period: ClubLogPeriod,
  periodKey: string,
  options: ClubLogServiceOptions = {},
): Promise<ClubLogDigestPost[]> {
  const parsedGuildId = requireGuildId(guildId);
  if (!isClubLogPeriod(period)) return [];
  const db = dbFor(options);
  const result = await db
    .from('guild_club_log_digest_posts')
    .select('log_id, period, period_key, channel_id, message_id')
    .eq('guild_id', parsedGuildId)
    .eq('period', period)
    .eq('period_key', periodKey);
  requireOk(result.error, 'Read club log digest posts');
  const allowedLogIds = new Set((await loadClubLogRows(parsedGuildId, { db })).map((log) => log.id));
  const posts: ClubLogDigestPost[] = [];
  for (const item of result.data ?? []) {
    const row = record(item);
    const logId = eventId(row?.['log_id']);
    const channelId = asString(row?.['channel_id']);
    const messageId = asString(row?.['message_id']);
    if (
      logId === null ||
      !allowedLogIds.has(logId) ||
      channelId === null ||
      messageId === null ||
      isDigestSentinel(messageId)
    ) {
      continue;
    }
    posts.push({ logId, period, periodKey, channelId, messageId });
  }
  return posts;
}

/**
 * Move one delivered daily digest row to the current UTC-day key without
 * creating a second pointer to the same Discord message. The caller must have
 * already rendered successfully; a conflict leaves the original row untouched.
 */
export async function rekeyClubLogDigestPost(
  guildId: string,
  post: ClubLogDigestPost,
  toPeriodKey: string,
  options: ClubLogServiceOptions = {},
): Promise<boolean> {
  const parsedGuildId = requireGuildId(guildId);
  if (post.periodKey === toPeriodKey) return true;
  if (!isClubLogPeriod(post.period)) return false;
  const db = dbFor(options);
  const allowedLogIds = new Set((await loadClubLogRows(parsedGuildId, { db })).map((log) => log.id));
  if (!allowedLogIds.has(post.logId)) return false;

  const target = await db
    .from('guild_club_log_digest_posts')
    .select('channel_id, message_id')
    .eq('guild_id', parsedGuildId)
    .eq('log_id', post.logId)
    .eq('period', post.period)
    .eq('period_key', toPeriodKey)
    .maybeSingle();
  requireOk(target.error, 'Read target club log digest post');
  const targetRow = record(target.data);
  if (targetRow !== null) {
    if (
      asString(targetRow['channel_id']) !== post.channelId ||
      asString(targetRow['message_id']) !== post.messageId
    ) {
      return false;
    }
    const duplicate = await db
      .from('guild_club_log_digest_posts')
      .delete()
      .eq('guild_id', parsedGuildId)
      .eq('log_id', post.logId)
      .eq('period', post.period)
      .eq('period_key', post.periodKey)
      .eq('message_id', post.messageId);
    requireOk(duplicate.error, 'Remove duplicate club log digest post');
    return true;
  }

  const moved = await db
    .from('guild_club_log_digest_posts')
    .update({ period_key: toPeriodKey })
    .eq('guild_id', parsedGuildId)
    .eq('log_id', post.logId)
    .eq('period', post.period)
    .eq('period_key', post.periodKey)
    .eq('message_id', post.messageId)
    .select('period_key');
  requireOk(moved.error, 'Advance club log digest post');
  return (moved.data ?? []).some(
    (item) => asString(record(item)?.['period_key']) === toPeriodKey,
  );
}

/**
 * Overwrite a claim sentinel with the real Discord message ID. Duplicate
 * inserts are intentionally not ignored here, or a pending claim would block
 * its own completion forever.
 */
export async function markClubLogDigestPosted(
  guildId: string,
  posts: readonly ClubLogDigestPost[],
  options: ClubLogServiceOptions = {},
): Promise<void> {
  const parsedGuildId = requireGuildId(guildId);
  if (posts.length === 0) return;
  const db = dbFor(options);
  const allowedLogIds = new Set((await loadClubLogRows(parsedGuildId, { db })).map((log) => log.id));
  const rows = posts
    .filter((post) => allowedLogIds.has(post.logId))
    .map((post) => ({
      guild_id: parsedGuildId,
      log_id: post.logId,
      period: post.period,
      period_key: post.periodKey,
      channel_id: post.channelId,
      message_id: post.messageId,
    }));
  if (rows.length === 0) return;
  const saved = await db.from('guild_club_log_digest_posts').upsert(rows, {
    onConflict: 'guild_id,log_id,period,period_key',
    ignoreDuplicates: false,
  });
  requireOk(saved.error, 'Record club log digest post');
}

/**
 * If the real ledger write fails after Discord accepted the post, keep the
 * message ID in the sentinel. The next claim reconciles it into a delivered
 * row and edits that message instead of posting the same window again.
 */
export async function markClubLogDigestClaimDelivered(
  guildId: string,
  claimId: string,
  posts: readonly ClubLogDigestPost[],
  options: ClubLogServiceOptions = {},
): Promise<void> {
  const parsedGuildId = requireGuildId(guildId);
  if (claimId === '' || posts.length === 0) return;
  const db = dbFor(options);

  const current = await db
    .from('guild_club_log_digest_posts')
    .select('log_id, period, period_key, message_id')
    .eq('guild_id', parsedGuildId);
  requireOk(current.error, 'Read club log digest claims');
  const byKey = new Map<string, string | null>();
  for (const item of current.data ?? []) {
    const row = record(item);
    const logId = eventId(row?.['log_id']);
    const period = asString(row?.['period']);
    const periodKey = asString(row?.['period_key']);
    if (logId === null || period === null || !isClubLogPeriod(period) || periodKey === null) {
      continue;
    }
    byKey.set(digestKey(logId, period, periodKey), asString(row?.['message_id']));
  }

  const rows = posts.flatMap((post) => {
    const key = digestKey(post.logId, post.period, post.periodKey);
    // Never overwrite a row that another writer already completed. Only a
    // `sending` claim can safely be converted into a delivered sentinel.
    if (byKey.get(key) !== digestClaimMessageId(claimId, key, 'sending')) return [];
    return [{
      guild_id: parsedGuildId,
      log_id: post.logId,
      period: post.period,
      period_key: post.periodKey,
      channel_id: post.channelId,
      message_id: digestDeliveredMessageId(claimId, post.periodKey, post.messageId),
    }];
  });
  if (rows.length === 0) return;

  const saved = await db.from('guild_club_log_digest_posts').upsert(rows, {
    onConflict: 'guild_id,log_id,period,period_key',
    ignoreDuplicates: false,
  });
  requireOk(saved.error, 'Persist club log digest message ID');
}
