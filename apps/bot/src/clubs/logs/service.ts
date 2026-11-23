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
const CLUB_CAPACITY = 30;
const EVENT_KINDS: readonly ClubLogEventKind[] = ['membership', 'role', 'capacity'];
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

function playerLabel(event: Pick<ClubLogEvent, 'playerTag' | 'playerName'>): string {
  if (event.playerTag !== null) return `#${event.playerTag}`;
  return event.playerName ?? 'Unknown player';
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

async function readDeliveredKeys(
  guildId: string,
  logId: string,
  period: ClubLogPeriod,
  db: DatabaseClient,
): Promise<Set<string>> {
  const result = await db
    .from('guild_club_log_deliveries')
    .select('event_kind, event_id')
    .eq('guild_id', guildId)
    .eq('log_id', logId)
    .eq('period', period)
    .in('event_kind', [...EVENT_KINDS]);
  requireOk(result.error, 'Read club log deliveries');
  const keys = new Set<string>();
  for (const item of result.data ?? []) {
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
  const clubTag = `#${cleanTag(log.clubTag)}`;

  let description: string | null = null;
  if (eventType === 'join' && toClubId === log.clubId) {
    description = `${label} joined ${clubTag}`;
  } else if (eventType === 'leave' && fromClubId === log.clubId) {
    description = `${label} left ${clubTag}`;
  } else if (eventType === 'transfer' && fromClubId === log.clubId && toClubId === log.clubId) {
    description = `${label} transferred within ${clubTag}`;
  } else if (eventType === 'transfer' && fromClubId === log.clubId) {
    description = `${label} transferred from ${clubTag} to another club`;
  } else if (eventType === 'transfer' && toClubId === log.clubId) {
    description = `${label} transferred from another club to ${clubTag}`;
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

async function loadEventsForLog(
  guildId: string,
  log: ClubLogRow,
  db: DatabaseClient,
  period: ClubLogPeriod,
  onlyUndelivered = true,
): Promise<ClubLogEvent[]> {
  const delivered = onlyUndelivered
    ? await readDeliveredKeys(guildId, log.id, period, db)
    : new Set<string>();

  // No subscription-time watermark: stored history is included so a newly added log
  // can backfill past joins, leaves, transfers, role and capacity changes. The delivery
  // ledger prevents reposts and the query/display caps bound how much is shown at once.
  const [membership, roles, capacity] = await Promise.all([
    db
      .from('membership_events')
      .select(
        'id, event_type, detected_at, from_club_id, to_club_id, player:players!membership_events_player_id_fkey(tag, name)',
      )
      .or(`from_club_id.eq.${log.clubId},to_club_id.eq.${log.clubId}`)
      .order('detected_at', { ascending: false })
      .limit(100),
    db
      .from('club_role_changes')
      .select(
        'id, from_role, to_role, detected_at, player:players!club_role_changes_player_id_fkey(tag, name, trophies)',
      )
      .eq('club_id', log.clubId)
      .order('detected_at', { ascending: false })
      .limit(100),
    db
      .from('club_capacity_events')
      .select('id, from_count, to_count, is_full, detected_at')
      .eq('club_id', log.clubId)
      .order('detected_at', { ascending: false })
      .limit(100),
  ]);
  requireOk(membership.error, 'Read club log membership events');
  requireOk(roles.error, 'Read club log role changes');
  requireOk(capacity.error, 'Read club log capacity events');

  const events: ClubLogEvent[] = [];
  for (const item of membership.data ?? []) {
    const event = parseMembershipEvent(item, log);
    if (event !== null) events.push(event);
  }
  for (const item of roles.data ?? []) {
    const event = parseRoleEvent(item, log);
    if (event !== null) events.push(event);
  }
  for (const item of capacity.data ?? []) {
    const event = parseCapacityEvent(item, log);
    if (event !== null) events.push(event);
  }

  return events
    .filter((event) => !delivered.has(`${event.kind}:${event.id}`))
    .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt) || left.id.localeCompare(right.id))
    .slice(0, MAX_EVENTS_PER_LOG);
}

/**
 * Undelivered stored change events for every log subscription in one guild.
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
    const periods: readonly ClubLogPeriod[] =
      fullLog.periods.length > 0 ? fullLog.periods : ['today'];
    for (const period of periods) {
      const events = await loadEventsForLog(parsedGuildId, fullLog, db, period);
      if (events.length === 0) continue;
      const { createdAt: _createdAt, ...log } = fullLog;
      groups.push({ log: { ...log, periods: [period] }, events });
    }
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
