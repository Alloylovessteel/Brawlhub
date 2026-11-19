/** Stored-only reads for the BrawlHub membership command group. */

import { createTrustedClient } from '@brawlhub/database';
import { brawlTagSchema, discordIdSchema, hasPermission, type Role } from '@brawlhub/shared';
import { getRegisteredClubs, record, requireOk } from '../clubs/service';
import type { ClubRecord } from '../clubs/types';
import {
  escapeIlike,
  parseMembershipRow,
  parsePlayerRow,
} from '../players/service';
import type { PlayerIdentity, PlayerMembershipRecord } from '../players/types';
import type {
  MemberListView,
  MemberSearchView,
  MembershipActor,
  ResolvedMemberSearchResult,
  ResolvedMembersResult,
  TrackedMemberRecord,
  TrackedPlayerEntry,
} from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

const PLAYER_COLUMNS = 'id, tag, name, trophies, highest_trophies, exp_level, last_synced_at';

const MEMBERSHIP_SELECT =
  'id, club_id, player_id, role, valid_from, valid_to, ' +
  'club:clubs!club_memberships_club_id_fkey(id, tag, name), ' +
  'player:players!club_memberships_player_id_fkey(' + PLAYER_COLUMNS + ')';

const INVALID_TAG_MESSAGE =
  'That club tag is not valid. Brawl Stars tags use 3–10 characters from 0, 2, 8, 9, C, G, J, L, P, Q, R, U, V and Y.';

export const INVALID_SEARCH_MESSAGE =
  'Enter 2–32 characters to search by player name or tag. Discord ID searches must be 17–20 digits.';

export const DISCORD_SEARCH_FORBIDDEN_MESSAGE =
  'You do not have permission to look up other Discord users’ linked players.';

export const NO_IDENTITY_LINK_MESSAGE =
  'No trusted Discord-to-player identity link is stored for that user.';

const STATUS_RANK: Readonly<Record<TrackedMemberRecord['status'], number>> = {
  current: 0,
  'last-recorded': 1,
  incomplete: 2,
  past: 3,
};

export interface MembershipReadOptions {
  readonly db?: DatabaseClient;
  readonly now?: Date;
  readonly staleAfterMs?: number;
  readonly guildId?: string | null;
  /** When true, the caller has already been authorized to inspect other users' identity links. */
  readonly allowInspectOthers?: boolean;
}

async function readGuildClubIds(guildId: string | null | undefined, db: DatabaseClient): Promise<string[] | null> {
  if (guildId === undefined || guildId === null || guildId.trim() === '') return null;
  const { data, error } = await db.from('clubs').select('id').eq('guild_id', guildId.trim());
  requireOk(error, 'Read guild clubs');
  return (data ?? [])
    .map((row: unknown) => {
      const rec = record(row);
      return typeof rec?.['id'] === 'string' ? (rec['id'] as string) : null;
    })
    .filter((id): id is string => id !== null);
}

/** Validate the free-text part of a `/member-search` query. */
export function normalizeMemberSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 32) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'staff' || value === 'member';
}

function emptyListView(club: ClubRecord | null): MemberListView {
  return { club, records: [], currentCount: 0, historicalCount: 0 };
}

function parseTrackedMemberRow(
  value: unknown,
  now: Date,
  staleAfterMs: number,
): TrackedMemberRecord | null {
  const row = record(value);
  if (row === null) return null;
  const player = parsePlayerRow(row['player']);
  if (player === null) return null;
  const membership = parseMembershipRow(row, staleAfterMs, now, player.lastSyncedAt);
  if (membership === null) return null;

  return {
    playerId: player.id ?? membership.id,
    playerTag: player.tag,
    playerName: player.name,
    trophies: player.trophies,
    club: membership,
    status: membership.status,
  };
}

function sortTrackedMembers(records: readonly TrackedMemberRecord[]): TrackedMemberRecord[] {
  return [...records].sort((first, second) => {
    const statusDifference = STATUS_RANK[first.status] - STATUS_RANK[second.status];
    if (statusDifference !== 0) return statusDifference;
    const firstFrom = Date.parse(first.club.validFrom ?? '');
    const secondFrom = Date.parse(second.club.validFrom ?? '');
    const timeDifference = (Number.isNaN(secondFrom) ? 0 : secondFrom) - (Number.isNaN(firstFrom) ? 0 : firstFrom);
    if (timeDifference !== 0) return timeDifference;
    return first.playerName.localeCompare(second.playerName);
  });
}

/** List stored memberships across registered clubs, optionally filtered by club tag. */
export async function loadTrackedMembers(
  input: { readonly tag?: string | undefined; readonly guildId?: string | null | undefined },
  options: MembershipReadOptions = {},
): Promise<ResolvedMembersResult<MemberListView>> {
  const db = options.db ?? createTrustedClient();
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  let normalizedTag: string | undefined;
  if (input.tag !== undefined && input.tag.trim() !== '') {
    const parsed = brawlTagSchema.safeParse(input.tag);
    if (!parsed.success) return { kind: 'invalid-tag', message: INVALID_TAG_MESSAGE };
    normalizedTag = parsed.data;
  }

  const clubs = await getRegisteredClubs(input.guildId, db);
  const club = normalizedTag === undefined
    ? null
    : clubs.find((candidate) => candidate.tag === normalizedTag) ?? null;
  if (normalizedTag !== undefined && club === null) {
    return {
      kind: 'unregistered',
      tag: normalizedTag,
      message: `Club #${normalizedTag} is not registered with BrawlHub.`,
    };
  }

  const clubIds = club === null ? clubs.map((candidate) => candidate.id) : [club.id];
  if (clubIds.length === 0) return { kind: 'ok', value: emptyListView(club) };

  const { data, error } = await db
    .from('club_memberships')
    .select(MEMBERSHIP_SELECT)
    .in('club_id', clubIds)
    .order('valid_from', { ascending: false })
    .limit(500);
  requireOk(error, 'Read tracked members');

  const records = (data ?? [])
    .map((value: unknown) => parseTrackedMemberRow(value, now, staleAfterMs))
    .filter((record): record is TrackedMemberRecord => record !== null);
  const sorted = sortTrackedMembers(records);

  return {
    kind: 'ok',
    value: {
      club,
      records: sorted,
      currentCount: sorted.filter((record) => record.status === 'current').length,
      historicalCount: sorted.filter((record) => record.status !== 'current').length,
    },
  };
}

function dedupePlayers(players: readonly PlayerIdentity[]): PlayerIdentity[] {
  const seenIds = new Set<string>();
  const seenTags = new Set<string>();
  const unique: PlayerIdentity[] = [];
  for (const player of players) {
    if (player.id !== null && seenIds.has(player.id)) continue;
    if (seenTags.has(player.tag)) continue;
    if (player.id !== null) seenIds.add(player.id);
    seenTags.add(player.tag);
    unique.push(player);
  }
  return unique;
}

interface MembershipWithPlayer {
  readonly playerId: string;
  readonly membership: PlayerMembershipRecord;
}

async function selectCurrentClubForPlayers(
  players: readonly PlayerIdentity[],
  db: DatabaseClient,
  now: Date,
  staleAfterMs: number,
  guildClubIds?: readonly string[] | null,
): Promise<readonly MembershipWithPlayer[]> {
  const playerIds = players
    .map((player) => player.id)
    .filter((id): id is string => id !== null);
  if (playerIds.length === 0) return [];

  let query = db
    .from('club_memberships')
    .select(MEMBERSHIP_SELECT)
    .in('player_id', playerIds)
    .order('valid_from', { ascending: false })
    .limit(1000);
  if (guildClubIds && guildClubIds.length > 0) {
    query = query.in('club_id', [...guildClubIds]);
  } else if (guildClubIds && guildClubIds.length === 0) {
    return [];
  }
  const { data, error } = await query;
  requireOk(error, 'Read current clubs');

  const best = new Map<string, MembershipWithPlayer>();
  for (const value of data ?? []) {
    const row = record(value);
    if (row === null) continue;
    const playerId = typeof row['player_id'] === 'string' ? row['player_id'] : null;
    const syncedAt = players.find((player) => player.id === playerId)?.lastSyncedAt ?? null;
    const membership = parseMembershipRow(row, staleAfterMs, now, syncedAt);
    if (membership === null || playerId === null) continue;
    const existing = best.get(playerId);
    const status = membership.status as keyof typeof STATUS_RANK;
    if (existing === undefined || STATUS_RANK[status] < STATUS_RANK[existing.membership.status]) {
      best.set(playerId, { playerId, membership });
    }
  }
  return [...best.values()];
}

function currentClubFor(
  player: PlayerIdentity,
  memberships: readonly MembershipWithPlayer[],
): TrackedPlayerEntry['currentClub'] {
  if (player.id === null) return null;
  const found = memberships.find((candidate) => candidate.playerId === player.id);
  if (found === undefined) return null;
  return found.membership.status === 'current' || found.membership.status === 'last-recorded'
    ? found.membership
    : null;
}

async function buildPlayerEntries(
  players: readonly PlayerIdentity[],
  options: MembershipReadOptions,
  guildClubIds?: readonly string[] | null,
): Promise<readonly TrackedPlayerEntry[]> {
  const db = options.db ?? createTrustedClient();
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const memberships = await selectCurrentClubForPlayers(players, db, now, staleAfterMs, guildClubIds);

  return players.map((player) => ({
    playerId: player.id ?? '',
    playerTag: player.tag,
    playerName: player.name,
    trophies: player.trophies,
    currentClub: currentClubFor(player, memberships),
  }));
}

/** Search tracked players by stored name or tag without contacting the official API. */
export async function searchTrackedMembersByPlayer(
  rawQuery: string,
  options: MembershipReadOptions = {},
): Promise<ResolvedMemberSearchResult<MemberSearchView>> {
  const query = normalizeMemberSearchQuery(rawQuery);
  if (query === null) return { kind: 'invalid-input', message: INVALID_SEARCH_MESSAGE };

  const db = options.db ?? createTrustedClient();
  const guildClubIds = await readGuildClubIds(options.guildId, db);
  const cleaned = query.replace(/^#+/, '');
  const escaped = escapeIlike(cleaned);
  const { data, error } = await db
    .from('players')
    .select(PLAYER_COLUMNS)
    .or(`tag.ilike.%${escaped}%,name.ilike.%${escaped}%`)
    .order('name', { ascending: true })
    .limit(200);
  requireOk(error, 'Search tracked players');

  let players = dedupePlayers(
    (data ?? [])
      .map((value: unknown) => parsePlayerRow(value))
      .filter((player): player is PlayerIdentity => player !== null),
  );
  if (guildClubIds !== null) {
    if (guildClubIds.length === 0) {
      players = [];
    } else {
      const { data: memberRows, error: memberError } = await db
        .from('club_memberships')
        .select('player_id')
        .in('club_id', guildClubIds)
        .in('player_id', players.map((p) => p.id).filter((id): id is string => id !== null))
        .limit(10000);
      requireOk(memberError, 'Read guild member players');
      const allowed = new Set(
        (memberRows ?? [])
          .map((row: unknown) => {
            const rec = record(row);
            return typeof rec?.['player_id'] === 'string' ? (rec['player_id'] as string) : null;
          })
          .filter((id): id is string => id !== null),
      );
      players = players.filter((player) => player.id !== null && allowed.has(player.id));
    }
  }
  return {
    kind: 'ok',
    value: {
      mode: 'player',
      query,
      entries: await buildPlayerEntries(players, options, guildClubIds),
      identityContext: false,
    },
  };
}

/** Resolve a Discord snowflake to the profile and global role stored in BrawlHub. */
export async function resolveMembershipActor(
  discordUserId: string,
  options: MembershipReadOptions = {},
): Promise<MembershipActor> {
  const db = options.db ?? createTrustedClient();
  const parsedId = discordIdSchema.safeParse(discordUserId);
  const actor: MembershipActor = {
    profileId: null,
    discordUserId: parsedId.success ? parsedId.data : discordUserId,
    globalRole: null,
  };
  if (!parsedId.success) return actor;

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id')
    .eq('discord_user_id', parsedId.data)
    .maybeSingle();
  requireOk(profileError, 'Read profile');
  const profileId = typeof record(profile)?.['id'] === 'string'
    ? (record(profile)?.['id'] as string)
    : null;
  if (profileId === null) return actor;

  const { data: roles, error: roleError } = await db
    .from('user_roles')
    .select('scope, club_id, role')
    .eq('user_id', profileId);
  requireOk(roleError, 'Read user roles');

  let globalRole: Role | null = null;
  for (const value of roles ?? []) {
    const row = record(value);
    if (row === null || row['scope'] !== 'global' || !isRole(row['role'])) continue;
    if (globalRole === null || roleRank(row['role']) > roleRank(globalRole)) {
      globalRole = row['role'];
    }
  }
  return { profileId, discordUserId: parsedId.data, globalRole };
}

function roleRank(role: Role): number {
  return ['member', 'staff', 'admin', 'owner'].indexOf(role);
}

/** Global staff permission is required to inspect another user's identity links. */
export function canInspectIdentityLinks(actor: MembershipActor): boolean {
  return actor.globalRole !== null && hasPermission(actor.globalRole, 'members:verify');
}

/** Search stored Discord identity links and the players they trust. */
export async function searchTrackedMembersByDiscord(
  rawDiscordUserId: string,
  actorDiscordUserId: string,
  options: MembershipReadOptions = {},
): Promise<ResolvedMemberSearchResult<MemberSearchView>> {
  const parsedId = discordIdSchema.safeParse(rawDiscordUserId);
  if (!parsedId.success) return { kind: 'invalid-input', message: INVALID_SEARCH_MESSAGE };
  const discordUserId = parsedId.data;

  const db = options.db ?? createTrustedClient();
  const guildClubIds = await readGuildClubIds(options.guildId, db);
  const actor = await resolveMembershipActor(actorDiscordUserId, { db });
  const isSelf = discordUserId === actor.discordUserId;
  if (!isSelf && !canInspectIdentityLinks(actor) && options.allowInspectOthers !== true) {
    return { kind: 'forbidden', message: DISCORD_SEARCH_FORBIDDEN_MESSAGE };
  }

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  requireOk(profileError, 'Read linked profile');
  const profileRow = record(profile);
  const profileId = typeof profileRow?.['id'] === 'string' ? profileRow['id'] : null;
  if (profileId === null) return { kind: 'no-identity-link', message: NO_IDENTITY_LINK_MESSAGE };

  const { data: links, error: linksError } = await db
    .from('player_verifications')
    .select(
      'profile_id, player_id, status, verified_at, ' +
      'player:players!player_verifications_player_id_fkey(' + PLAYER_COLUMNS + ')',
    )
    .eq('profile_id', profileId)
    .eq('status', 'active')
    .order('verified_at', { ascending: false })
    .limit(100);
  requireOk(linksError, 'Read identity links');

  let players = dedupePlayers(
    (links ?? [])
      .map((value: unknown) => parsePlayerRow(record(value)?.['player']))
      .filter((player): player is PlayerIdentity => player !== null),
  );
  if (guildClubIds !== null) {
    if (guildClubIds.length === 0) {
      players = [];
    } else {
      const { data: memberRows, error: memberError } = await db
        .from('club_memberships')
        .select('player_id')
        .in('club_id', guildClubIds)
        .in('player_id', players.map((p) => p.id).filter((id): id is string => id !== null))
        .limit(10000);
      requireOk(memberError, 'Read guild member players');
      const allowed = new Set(
        (memberRows ?? [])
          .map((row: unknown) => {
            const rec = record(row);
            return typeof rec?.['player_id'] === 'string' ? (rec['player_id'] as string) : null;
          })
          .filter((id): id is string => id !== null),
      );
      players = players.filter((player) => player.id !== null && allowed.has(player.id));
    }
  }
  if (players.length === 0) return { kind: 'no-identity-link', message: NO_IDENTITY_LINK_MESSAGE };

  return {
    kind: 'ok',
    value: {
      mode: 'discord',
      query: discordUserId,
      entries: await buildPlayerEntries(players, options, guildClubIds),
      identityContext: true,
    },
  };
}

