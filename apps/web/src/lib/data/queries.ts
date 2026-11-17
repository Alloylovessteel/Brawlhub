import { createServerSupabaseClient } from '@/lib/supabase';
import { z } from 'zod';
import type {
  ClubRow,
  ClubSnapshotRow,
  MembershipEventRow,
  MembershipRow,
  NotificationRow,
  PlayerRow,
  PlayerSnapshotRow,
  QueryResult,
  SyncRunRow,
} from './types';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const searchSchema = z.string().trim().max(100).default('');
const uuidSchema = z.uuid();

export interface PaginationInput {
  page?: string | string[] | undefined;
  pageSize?: string | string[] | undefined;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parsePagination(input: PaginationInput): { page: number; pageSize: number } {
  return paginationSchema.parse({
    page: firstValue(input.page) ?? '1',
    pageSize: firstValue(input.pageSize) ?? '50',
  });
}

export function parseSearch(value: string | string[] | undefined): string {
  return searchSchema.parse(firstValue(value) ?? '');
}

function parseUuid(value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function errorText(error: { message: string } | null | undefined): string | null {
  return error === null || error === undefined ? null : error.message;
}

function emptyResult<T>(error: string | null): QueryResult<T> {
  return { rows: [], count: 0, error };
}

type AnyRecord = Record<string, any>;

function relationRecord(value: unknown): AnyRecord | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'object' && candidate !== null ? (candidate as AnyRecord) : undefined;
}

function toClubRef(value: unknown): ClubRow | undefined {
  const row = relationRecord(value);
  if (row === undefined || typeof row['id'] !== 'string') return undefined;
  return {
    id: row['id'],
    tag: typeof row['tag'] === 'string' ? row['tag'] : '',
    name: typeof row['name'] === 'string' ? row['name'] : 'Unrecorded club',
    badge_id: typeof row['badge_id'] === 'number' ? row['badge_id'] : null,
  } as ClubRow;
}

function toPlayerRef(value: unknown): PlayerRow | undefined {
  const row = relationRecord(value);
  if (row === undefined || typeof row['id'] !== 'string') return undefined;
  return {
    id: row['id'],
    tag: typeof row['tag'] === 'string' ? row['tag'] : '',
    name: typeof row['name'] === 'string' ? row['name'] : 'Unrecorded player',
    trophies: typeof row['trophies'] === 'number' ? row['trophies'] : null,
  } as PlayerRow;
}

function normalizeMemberships(data: unknown): MembershipRow[] {
  return (Array.isArray(data) ? data : []).map((item) => {
    const row = item as AnyRecord;
    const club = toClubRef(row['club']);
    const player = toPlayerRef(row['player']);
    return {
      id: String(row['id']),
      club_id: String(row['club_id']),
      player_id: String(row['player_id']),
      role: typeof row['role'] === 'string' ? row['role'] : null,
      valid_from: String(row['valid_from']),
      valid_to: typeof row['valid_to'] === 'string' ? row['valid_to'] : null,
      ...(club === undefined ? {} : { club }),
      ...(player === undefined ? {} : { player }),
    };
  });
}

function normalizeEvents(data: unknown): MembershipEventRow[] {
  return (Array.isArray(data) ? data : []).map((item) => {
    const row = item as AnyRecord;
    const player = toPlayerRef(row['player']);
    const fromClub = toClubRef(row['from_club']);
    const toClub = toClubRef(row['to_club']);
    return {
      id: String(row['id']),
      player_id: String(row['player_id']),
      from_club_id: typeof row['from_club_id'] === 'string' ? row['from_club_id'] : null,
      to_club_id: typeof row['to_club_id'] === 'string' ? row['to_club_id'] : null,
      event_type: row['event_type'] as MembershipEventRow['event_type'],
      detected_at: String(row['detected_at']),
      ...(player === undefined ? {} : { player }),
      ...(fromClub === undefined ? {} : { from_club: fromClub }),
      ...(toClub === undefined ? {} : { to_club: toClub }),
    };
  });
}

function escapeIlike(value: string): string {
  return value.replace(/[%,()\\]/g, '\\$&');
}

export async function getClubs(input: {
  search?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<QueryResult<ClubRow>> {
  const supabase = await createServerSupabaseClient();
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  let query = supabase
    .from('clubs')
    .select(
      'id, tag, name, description, badge_id, trophies, required_trophies, member_count, last_synced_at, created_at, updated_at',
      { count: 'exact' },
    )
    .order('trophies', { ascending: false, nullsFirst: false });

  const search = parseSearch(input.search);
  if (search.length > 0) {
    const escaped = escapeIlike(search);
    query = query.or(`name.ilike.%${escaped}%,tag.ilike.%${escaped}%`);
  }

  const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
  return {
    rows: (data ?? []) as ClubRow[],
    count: count ?? 0,
    error: errorText(error),
  };
}

export async function getClubById(id: string): Promise<QueryResult<ClubRow>> {
  const validId = parseUuid(id);
  if (validId === null) return emptyResult('Invalid club id');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('clubs')
    .select(
      'id, tag, name, description, badge_id, trophies, required_trophies, member_count, last_synced_at, created_at, updated_at',
    )
    .eq('id', validId)
    .maybeSingle();
  return {
    rows: data === null ? [] : [data as ClubRow],
    count: data === null ? 0 : 1,
    error: errorText(error),
  };
}

export async function getPlayers(input: {
  search?: string;
  clubId?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<QueryResult<PlayerRow>> {
  const supabase = await createServerSupabaseClient();
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;

  let playerIds: string[] | undefined;
  if (input.clubId !== undefined) {
    const validClubId = parseUuid(input.clubId);
    if (validClubId === null) return emptyResult('Invalid club id');
    const membershipResult = await supabase
      .from('club_memberships')
      .select('player_id')
      .eq('club_id', validClubId)
      .is('valid_to', null);
    if (membershipResult.error !== null && membershipResult.error !== undefined) {
      return emptyResult(membershipResult.error.message);
    }
    playerIds = (membershipResult.data ?? []).map((row) => String(row.player_id));
    if (playerIds.length === 0) return emptyResult(null);
  }

  let query = supabase
    .from('players')
    .select(
      'id, tag, name, trophies, highest_trophies, exp_level, power_points, victories, solo_victories, team_victories, last_synced_at, created_at, updated_at',
      { count: 'exact' },
    )
    .order('trophies', { ascending: false, nullsFirst: false });
  if (playerIds !== undefined) query = query.in('id', playerIds);

  const search = parseSearch(input.search);
  if (search.length > 0) {
    const escaped = escapeIlike(search);
    query = query.or(`name.ilike.%${escaped}%,tag.ilike.%${escaped}%`);
  }

  const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
  return {
    rows: (data ?? []) as PlayerRow[],
    count: count ?? 0,
    error: errorText(error),
  };
}

export async function getPlayerById(id: string): Promise<QueryResult<PlayerRow>> {
  const validId = parseUuid(id);
  if (validId === null) return emptyResult('Invalid player id');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('players')
    .select(
      'id, tag, name, trophies, highest_trophies, exp_level, power_points, victories, solo_victories, team_victories, last_synced_at, created_at, updated_at',
    )
    .eq('id', validId)
    .maybeSingle();
  return {
    rows: data === null ? [] : [data as PlayerRow],
    count: data === null ? 0 : 1,
    error: errorText(error),
  };
}

export async function getCurrentRoster(clubId: string): Promise<QueryResult<MembershipRow>> {
  const validClubId = parseUuid(clubId);
  if (validClubId === null) return emptyResult('Invalid club id');
  const supabase = await createServerSupabaseClient();
  const { data, count, error } = await supabase
    .from('club_memberships')
    .select(
      'id, club_id, player_id, role, valid_from, valid_to, player:players!club_memberships_player_id_fkey(id, tag, name, trophies)',
      { count: 'exact' },
    )
    .eq('club_id', validClubId)
    .is('valid_to', null);

  const rows = normalizeMemberships(data).sort(
    (a, b) => (b.player?.trophies ?? -1) - (a.player?.trophies ?? -1),
  );
  return { rows, count: count ?? rows.length, error: errorText(error) };
}

export async function getPlayerMemberships(playerId: string): Promise<QueryResult<MembershipRow>> {
  const validId = parseUuid(playerId);
  if (validId === null) return emptyResult('Invalid player id');
  const supabase = await createServerSupabaseClient();
  const { data, count, error } = await supabase
    .from('club_memberships')
    .select(
      'id, club_id, player_id, role, valid_from, valid_to, club:clubs!club_memberships_club_id_fkey(id, tag, name, badge_id)',
      { count: 'exact' },
    )
    .eq('player_id', validId)
    .order('valid_from', { ascending: false });
  return { rows: normalizeMemberships(data), count: count ?? 0, error: errorText(error) };
}

const EVENT_SELECT = `
  id, player_id, from_club_id, to_club_id, event_type, detected_at,
  player:players!membership_events_player_id_fkey(id, tag, name, trophies),
  from_club:clubs!membership_events_from_club_id_fkey(id, tag, name, badge_id),
  to_club:clubs!membership_events_to_club_id_fkey(id, tag, name, badge_id)
`;

export async function getRecentEvents(limit = 20): Promise<QueryResult<MembershipEventRow>> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('membership_events')
    .select(EVENT_SELECT)
    .order('detected_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return { rows: normalizeEvents(data), count: data?.length ?? 0, error: errorText(error) };
}

export async function getClubEvents(
  clubId: string,
  limit = 30,
): Promise<QueryResult<MembershipEventRow>> {
  const validClubId = parseUuid(clubId);
  if (validClubId === null) return emptyResult('Invalid club id');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('membership_events')
    .select(EVENT_SELECT)
    .or(`from_club_id.eq.${validClubId},to_club_id.eq.${validClubId}`)
    .order('detected_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return { rows: normalizeEvents(data), count: data?.length ?? 0, error: errorText(error) };
}

export async function getPlayerEvents(playerId: string): Promise<QueryResult<MembershipEventRow>> {
  const validId = parseUuid(playerId);
  if (validId === null) return emptyResult('Invalid player id');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('membership_events')
    .select(EVENT_SELECT)
    .eq('player_id', validId)
    .order('detected_at', { ascending: false });
  return { rows: normalizeEvents(data), count: data?.length ?? 0, error: errorText(error) };
}

export async function getClubSnapshots(
  clubId: string,
  input: { days?: number; limit?: number } = {},
): Promise<QueryResult<ClubSnapshotRow>> {
  const validClubId = parseUuid(clubId);
  if (validClubId === null) return emptyResult('Invalid club id');
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from('club_snapshots')
    .select('id, club_id, sync_run_id, captured_at, trophies, member_count, payload_hash')
    .eq('club_id', validClubId)
    .order('captured_at', { ascending: true });
  if (input.days !== undefined) {
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('captured_at', since);
  }
  if (input.limit !== undefined) query = query.limit(input.limit);
  const { data, count, error } = await query;
  return { rows: (data ?? []) as ClubSnapshotRow[], count: count ?? 0, error: errorText(error) };
}

export async function getPlayerSnapshots(
  playerId: string,
  input: { days?: number; limit?: number } = {},
): Promise<QueryResult<PlayerSnapshotRow>> {
  const validId = parseUuid(playerId);
  if (validId === null) return emptyResult('Invalid player id');
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from('player_snapshots')
    .select('id, player_id, sync_run_id, captured_at, trophies, payload_hash')
    .eq('player_id', validId)
    .order('captured_at', { ascending: true });
  if (input.days !== undefined) {
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('captured_at', since);
  }
  if (input.limit !== undefined) query = query.limit(input.limit);
  const { data, count, error } = await query;
  return { rows: (data ?? []) as PlayerSnapshotRow[], count: count ?? 0, error: errorText(error) };
}

export async function getSyncRuns(limit = 20): Promise<QueryResult<SyncRunRow>> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('sync_runs')
    .select(
      'id, scope, period_start, status, started_at, finished_at, error, last_error, records_processed, affected_club_ids, club_tags',
    )
    .order('started_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return { rows: (data ?? []) as SyncRunRow[], count: data?.length ?? 0, error: errorText(error) };
}

export async function getNotifications(limit = 50): Promise<QueryResult<NotificationRow>> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('notifications')
    .select('id, event_id, event_type, channel_id, kind, discord_message_id, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return { rows: (data ?? []) as NotificationRow[], count: data?.length ?? 0, error: errorText(error) };
}

export interface OverviewData {
  hasData: boolean;
  clubs: number;
  players: number;
  memberships: number;
  trophies: { total: number | null; average: number | null };
  latestSync: SyncRunRow | null;
  recentEvents: MembershipEventRow[];
  recentRuns: SyncRunRow[];
  staleSync: boolean;
  error: string | null;
}

export async function getOverview(): Promise<OverviewData> {
  const [clubs, players, syncRuns, events] = await Promise.all([
    getClubs({ page: 1, pageSize: 1 }),
    getPlayers({ page: 1, pageSize: 1 }),
    getSyncRuns(10),
    getRecentEvents(12),
  ]);

  const supabase = await createServerSupabaseClient();
  const membershipResult = await supabase
    .from('club_memberships')
    .select('*', { count: 'exact', head: true })
    .is('valid_to', null);

  const trophyResult = await supabase.from('players').select('trophies');
  const trophyValues = (trophyResult.data ?? [])
    .map((row) => row.trophies)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const totalTrophies = trophyValues.length > 0 ? trophyValues.reduce((sum, value) => sum + value, 0) : null;

  const latestSync = syncRuns.rows.find((run) => run.status === 'completed') ?? null;
  const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? '15');
  const intervalMs = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 15;
  const staleAfterMs = Math.max(intervalMs * 2, 2) * 60 * 1000;
  const staleSync =
    latestSync?.finished_at === null ||
    latestSync === null ||
    Date.now() - new Date(latestSync.finished_at ?? 0).getTime() > staleAfterMs;

  const error =
    clubs.error ??
    players.error ??
    syncRuns.error ??
    events.error ??
    errorText(membershipResult.error) ??
    trophyResult.error?.message ??
    null;

  return {
    hasData: clubs.count > 0 || players.count > 0,
    clubs: clubs.count,
    players: players.count,
    memberships: membershipResult.count ?? 0,
    trophies: {
      total: totalTrophies,
      average:
        totalTrophies === null || trophyValues.length === 0
          ? null
          : Math.round(totalTrophies / trophyValues.length),
    },
    latestSync,
    recentEvents: events.rows,
    recentRuns: syncRuns.rows,
    staleSync,
    error,
  };
}

export interface ClubSummary {
  club: ClubRow;
  latestSnapshot: ClubSnapshotRow | null;
  snapshots: ClubSnapshotRow[];
  rosterCount: number;
  averageMemberTrophies: number | null;
}

export async function getClubSummaries(): Promise<QueryResult<ClubSummary>> {
  const clubs = await getClubs({ page: 1, pageSize: 100 });
  if (clubs.error !== null || clubs.rows.length === 0) {
    return emptyResult(clubs.error);
  }

  const summaries = await Promise.all(
    clubs.rows.map(async (club) => {
      const [snapshots, roster] = await Promise.all([
        getClubSnapshots(club.id),
        getCurrentRoster(club.id),
      ]);
      const trophyValues = roster.rows
        .map((row) => row.player?.trophies)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const total = trophyValues.reduce((sum, value) => sum + value, 0);
      return {
        club,
        latestSnapshot: snapshots.rows.at(-1) ?? null,
        snapshots: snapshots.rows,
        rosterCount: roster.count,
        averageMemberTrophies: trophyValues.length > 0 ? Math.round(total / trophyValues.length) : null,
      } satisfies ClubSummary;
    }),
  );

  return { rows: summaries, count: summaries.length, error: null };
}
