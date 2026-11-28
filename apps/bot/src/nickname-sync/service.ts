import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client, Guild, GuildMember } from 'discord.js';
import { AdminServiceError, recordAdminAudit } from '../admin/service.js';
import type { AdminActor } from '../admin/types.js';
import { asString, record, requireOk } from '../clubs/service.js';
import { selectGuildMainLinks } from '../ranked-roles/service.js';
import { listGuildVerifiedLinks, type RegisteredLinkView } from '../verification/service.js';

const logger = createLogger('bot/nickname-sync');
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const DISCORD_NICKNAME_LIMIT = 32;
const PREFIX_LIMIT = 16;
const NICKNAME_REASON = 'BrawlHub verified player nickname';
const NICKNAME_RELEASE_REASON = 'Restore previous nickname after BrawlHub management ended';
const LEDGER_TABLE = 'guild_managed_nicknames';
const LEDGER_COLUMNS =
  'guild_id, discord_user_id, applied_nickname, previous_nickname, source, source_id, ' +
  'player_id, player_tag, player_name, prefix, applied_at, updated_at, last_seen_at, released_at, ' +
  'cycle_id, confirmed_at, pending_cycle_id, pending_applied_nickname, pending_previous_nickname';
const NICKNAME_PAGE_SIZE = 1000;
const MAX_NICKNAME_PAGES = 100;
const ACTIVE_GUILD_PAGE_SIZE = 1000;
const MAX_ACTIVE_GUILD_PAGES = 100;

export interface NicknameServiceOptions {
  readonly db?: SupabaseClient;
}

export interface GuildNicknameSettings {
  readonly guildId: string;
  readonly enabled: boolean;
  readonly prefix: string | null;
}

/** Where a nickname write came from; stored with the managed-nickname ledger row. */
export interface NicknameSource {
  readonly source: string;
  readonly sourceId?: string | null;
}

/** A verification hint is corroborating evidence, never an ownership proof. */
export interface PlayerNameHint {
  readonly playerName?: string | null;
  readonly playerTag?: string | null;
}

export type NicknameHintInput = string | PlayerNameHint | null | undefined;

export type NicknameSyncKind =
  | 'ok'
  | 'unchanged'
  | 'disabled'
  | 'not-verified'
  | 'not-member'
  | 'unresolved'
  | 'skipped-owner'
  | 'skipped-bot'
  | 'failed';

export type NicknameSyncResult = {
  readonly kind: NicknameSyncKind;
  readonly nickname?: string;
  /** True when a managed ledger row was released during this sync. */
  readonly released?: boolean;
};

export type ManagedNicknameReleaseKind =
  | 'released'
  | 'unchanged'
  | 'no-ledger'
  | 'not-member'
  | 'unresolved'
  | 'skipped-owner'
  | 'skipped-bot'
  | 'failed';

export interface ManagedNicknameReleaseResult {
  readonly kind: ManagedNicknameReleaseKind;
  /** True when the row was marked released, even if Discord was not mutated. */
  readonly released?: boolean;
  /** True when Discord's nickname was restored (including clearing it to null). */
  readonly restored?: boolean;
  /** True when Discord confirmed the member is gone and only the ledger was released. */
  readonly notMember?: boolean;
}

export type NicknameHookResult = NicknameSyncResult | ManagedNicknameReleaseResult;

export interface GuildNicknameSyncSummary {
  readonly guilds: number;
  readonly members: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly notMembers: number;
  /** Discord membership could not be established (transient/error), not confirmed missing. */
  readonly unresolved: number;
  /** Previous nicknames actually restored (including clears to null). */
  readonly restored: number;
  /** Managed ledger rows released. */
  readonly released: number;
  readonly failures: number;
  /** True when not every active ledger row could be read and restored. */
  readonly cleanupIncomplete: boolean;
}

interface ManagedNicknameRow {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly appliedNickname: string;
  readonly previousNickname: string | null;
  readonly source: string;
  readonly sourceId: string | null;
  readonly playerId: string | null;
  readonly playerTag: string | null;
  readonly playerName: string | null;
  readonly prefix: string | null;
  readonly appliedAt: string | null;
  readonly updatedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly releasedAt: string | null;
  readonly cycleId: string;
  readonly confirmedAt: string | null;
  readonly pendingCycleId: string | null;
  readonly pendingAppliedNickname: string | null;
  readonly pendingPreviousNickname: string | null;
}

interface MemberLookup {
  readonly member: GuildMember | null;
  readonly kind: 'ok' | 'not-member' | 'unresolved';
}

type MutableSummary = {
  -readonly [K in keyof GuildNicknameSyncSummary]: GuildNicknameSyncSummary[K];
};

function emptySummary(guilds = 0): MutableSummary {
  return {
    guilds,
    members: 0,
    updated: 0,
    unchanged: 0,
    notMembers: 0,
    unresolved: 0,
    restored: 0,
    released: 0,
    failures: 0,
    cleanupIncomplete: false,
  };
}

function dbFor(options: NicknameServiceOptions): SupabaseClient {
  return options.db ?? createTrustedClient();
}

function requireSnowflake(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SNOWFLAKE_PATTERN.test(trimmed)) {
    throw new AdminServiceError('invalid_guild', `A valid Discord ${label} is required.`);
  }
  return trimmed;
}

function truncate(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

/** Strip control characters, mentions and formatting tokens from user-supplied text. */
function sanitizeText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a stored club-tag prefix while preserving brackets as typed. */
export function normalizePrefix(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = sanitizeText(value);
  if (cleaned === '') return null;
  return truncate(cleaned, PREFIX_LIMIT);
}

function normalizePlayerName(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = sanitizeText(value);
  return cleaned === '' ? null : cleaned;
}

/** Format `[PREFIX] PlayerName` (or just `PlayerName`) within Discord's 32-char limit. */
export function formatNickname(prefix: string | null, playerName: string): string {
  const name = normalizePlayerName(playerName) ?? 'BrawlHub member';
  const cleanPrefix = normalizePrefix(prefix);
  if (cleanPrefix === null) return truncate(name, DISCORD_NICKNAME_LIMIT);

  const roomForName = Math.max(0, DISCORD_NICKNAME_LIMIT - Array.from(cleanPrefix).length - 1);
  const shortName = truncate(name, roomForName);
  return shortName === '' ? cleanPrefix : `${cleanPrefix} ${shortName}`;
}

/** Read one guild's nickname-sync settings with the trusted database client. */
export async function loadGuildNicknameSettings(
  guildId: string,
  options: NicknameServiceOptions = {},
): Promise<GuildNicknameSettings> {
  const parsedGuildId = requireSnowflake(guildId, 'guild');
  const result = await dbFor(options)
    .from('guild_settings')
    .select('guild_id, nickname_prefix, nickname_sync_enabled')
    .eq('guild_id', parsedGuildId)
    .maybeSingle();
  requireOk(result.error, 'Read nickname sync settings');
  const row = record(result.data);
  return {
    guildId: parsedGuildId,
    enabled: row?.['nickname_sync_enabled'] !== false,
    prefix: normalizePrefix(asString(row?.['nickname_prefix'])),
  };
}

/** Persist a guild's nickname prefix and enable flag with an auditable event. */
export async function saveGuildNicknameSettings(
  input: {
    readonly guildId: string;
    readonly actor: AdminActor;
    readonly prefix?: string | null;
    readonly enabled?: boolean;
  },
  options: NicknameServiceOptions = {},
): Promise<GuildNicknameSettings> {
  const parsedGuildId = requireSnowflake(input.guildId, 'guild');
  const db = dbFor(options);
  const current = await loadGuildNicknameSettings(parsedGuildId, { db });
  const prefix = input.prefix === undefined ? current.prefix : normalizePrefix(input.prefix);
  const enabled = input.enabled === undefined ? current.enabled : input.enabled;

  const saved = await db.from('guild_settings').upsert(
    {
      guild_id: parsedGuildId,
      nickname_prefix: prefix,
      nickname_sync_enabled: enabled,
    },
    { onConflict: 'guild_id' },
  );
  requireOk(saved.error, 'Save nickname sync settings');

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'guild.nickname_sync.updated',
      targetType: 'guild',
      targetId: parsedGuildId,
      guildId: parsedGuildId,
      details: { nicknamePrefix: prefix, nicknameSyncEnabled: enabled },
    },
    { db, guildId: parsedGuildId },
  );

  return loadGuildNicknameSettings(parsedGuildId, { db });
}

function normalizeHint(hint: NicknameHintInput): { readonly name: string | null; readonly tag: string | null } {
  if (typeof hint === 'string') return { name: normalizePlayerName(hint), tag: null };
  const row = record(hint);
  if (row === null) return { name: null, tag: null };
  return {
    name: normalizePlayerName(asString(row['playerName']) ?? asString(row['name'])),
    tag: asString(row['playerTag']) ?? asString(row['tag']),
  };
}

/**
 * Pick the verified main for each Discord user in one guild. `selectGuildMainLinks`
 * stays the source of truth where `is_main` exists; a single current guild link
 * with no main at all (a freshly verified first account) is the explicit fallback.
 */
export function selectEligibleGuildMains(
  links: readonly RegisteredLinkView[],
): RegisteredLinkView[] {
  const mains = selectGuildMainLinks(
    links.map((link) => ({
      discordUserId: link.discordUserId,
      playerId: link.playerId,
      isMain: link.isMain,
    })),
  );
  const chosen = new Map<string, RegisteredLinkView>();
  for (const main of mains) {
    const link = links.find(
      (candidate) =>
        candidate.discordUserId === main.discordUserId && candidate.playerId === main.playerId,
    );
    if (link !== undefined) chosen.set(link.discordUserId, link);
  }
  for (const link of links) {
    if (chosen.has(link.discordUserId)) continue;
    const userLinks = links.filter((candidate) => candidate.discordUserId === link.discordUserId);
    if (userLinks.length === 1 && !userLinks[0]!.isMain) {
      chosen.set(link.discordUserId, userLinks[0]!);
    }
  }
  return [...chosen.values()];
}

/**
 * Always resolve the current guild-scoped main from the database after a link
 * mutation. A supplied verification hint is only compared against that stored
 * identity; it is never used to infer which account is linked.
 */
export async function resolveVerifiedGuildMain(
  guildId: string,
  discordUserId: string,
  hint: NicknameHintInput = null,
  options: NicknameServiceOptions = {},
): Promise<RegisteredLinkView | null> {
  const links = await listGuildVerifiedLinks(guildId, options);
  const main = selectEligibleGuildMains(links).find(
    (link) => link.discordUserId === discordUserId,
  );
  if (main === undefined) return null;

  const normalized = normalizeHint(hint);
  const storedName = normalizePlayerName(main.name);
  if (normalized.name !== null && storedName !== null && normalized.name !== storedName) {
    logger.warn('Verification nickname hint did not match the stored guild main', {
      guildId,
      discordUserId,
      storedPlayerTag: main.tag,
    });
  }
  if (normalized.tag !== null && normalized.tag !== main.tag) {
    logger.warn('Verification tag hint did not match the stored guild main', {
      guildId,
      discordUserId,
      storedPlayerTag: main.tag,
    });
  }
  return main;
}

/** Resolve just the stored player name; kept for the public service surface. */
export async function resolveVerifiedPlayerName(
  guildId: string,
  discordUserId: string,
  hint: NicknameHintInput = null,
  options: NicknameServiceOptions = {},
): Promise<string | null> {
  const main = await resolveVerifiedGuildMain(guildId, discordUserId, hint, options);
  return main === null ? null : normalizePlayerName(main.name);
}

function parseManagedRow(value: unknown): ManagedNicknameRow | null {
  const row = record(value);
  if (row === null) return null;
  const guildId = asString(row['guild_id']);
  const discordUserId = asString(row['discord_user_id']);
  const appliedNickname = asString(row['applied_nickname']);
  if (guildId === null || discordUserId === null || appliedNickname === null) return null;
  return {
    guildId,
    discordUserId,
    appliedNickname,
    previousNickname: asString(row['previous_nickname']),
    source: asString(row['source']) ?? 'unknown',
    sourceId: asString(row['source_id']),
    playerId: asString(row['player_id']),
    playerTag: asString(row['player_tag']),
    playerName: asString(row['player_name']),
    prefix: asString(row['prefix']),
    appliedAt: asString(row['applied_at']),
    updatedAt: asString(row['updated_at']),
    lastSeenAt: asString(row['last_seen_at']),
    releasedAt: asString(row['released_at']),
    cycleId: asString(row['cycle_id']) ?? '',
    confirmedAt: asString(row['confirmed_at']),
    pendingCycleId: asString(row['pending_cycle_id']),
    pendingAppliedNickname: asString(row['pending_applied_nickname']),
    pendingPreviousNickname: asString(row['pending_previous_nickname']),
  };
}

async function readManagedRow(
  guildId: string,
  discordUserId: string,
  db: SupabaseClient,
): Promise<ManagedNicknameRow | null> {
  const result = await db
    .from(LEDGER_TABLE)
    .select(LEDGER_COLUMNS)
    .eq('guild_id', guildId)
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  requireOk(result.error, 'Read managed nickname');
  return parseManagedRow(result.data);
}

async function readActiveManagedRows(
  guildId: string,
  db: SupabaseClient,
): Promise<ManagedNicknameRow[]> {
  const rows: ManagedNicknameRow[] = [];
  const seen = new Set<string>();
  let afterDiscordUserId: string | null = null;

  for (let page = 0; page < MAX_NICKNAME_PAGES; page += 1) {
    const result: { data: unknown; error: { message?: string } | null } = await db.rpc('guild_managed_nickname_page', {
      p_guild_id: guildId,
      p_limit: NICKNAME_PAGE_SIZE,
      p_after_discord_user_id: afterDiscordUserId,
    });
    requireOk(result.error, 'Read active managed nicknames');
    const pageRows = (Array.isArray(result.data) ? result.data : [])
      .map(parseManagedRow)
      .filter((row): row is ManagedNicknameRow => row !== null);
    if (pageRows.length === 0) return rows;

    let lastId: string | null = null;
    for (const row of pageRows) {
      if (
        seen.has(row.discordUserId) ||
        (afterDiscordUserId !== null && row.discordUserId <= afterDiscordUserId)
      ) {
        throw new Error('Read active managed nicknames: non-monotonic keyset');
      }
      seen.add(row.discordUserId);
      rows.push(row);
      lastId = row.discordUserId;
    }
    if (pageRows.length < NICKNAME_PAGE_SIZE) return rows;
    if (lastId === null) throw new Error('Read active managed nicknames: missing keyset');
    afterDiscordUserId = lastId;
  }
  throw new Error('Read active managed nicknames: page limit exceeded');
}

interface ManagedNicknameWrite {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly appliedNickname: string;
  readonly source: NicknameSource;
  readonly main: RegisteredLinkView;
  readonly prefix: string | null;
}

interface NicknameConfirmation {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly cycleId: string;
  /** The nickname actually observed in Discord before this confirmation. */
  readonly expectedAppliedNickname?: string | null;
  readonly source: string;
  readonly sourceId: string | null;
  readonly playerId: string | null;
  readonly playerTag: string | null;
  readonly playerName: string | null;
  readonly prefix: string | null;
}

/** Persist a recoverable intent before Discord is asked to change a nickname. */
async function persistNicknameIntent(
  input: ManagedNicknameWrite,
  cycleId: string,
  previousNickname: string | null,
  db: SupabaseClient,
): Promise<void> {
  const result = await db.rpc('managed_nickname_intent', {
    p_guild_id: input.guildId,
    p_discord_user_id: input.discordUserId,
    p_cycle_id: cycleId,
    p_applied_nickname: input.appliedNickname,
    p_previous_nickname: previousNickname,
    p_source: input.source.source,
    p_source_id: input.source.sourceId ?? null,
    p_player_id: input.main.playerId,
    p_player_tag: input.main.tag,
    p_player_name: input.main.name,
    p_prefix: input.prefix,
  });
  requireOk(result.error, 'Record managed nickname intent');
}

function confirmationForWrite(
  write: ManagedNicknameWrite,
  cycleId: string,
  expectedAppliedNickname?: string | null,
): NicknameConfirmation {
  return {
    guildId: write.guildId,
    discordUserId: write.discordUserId,
    cycleId,
    expectedAppliedNickname: expectedAppliedNickname ?? null,
    source: write.source.source,
    sourceId: write.source.sourceId ?? null,
    playerId: write.main.playerId,
    playerTag: write.main.tag,
    playerName: write.main.name,
    prefix: write.prefix,
  };
}

function confirmationForRow(row: ManagedNicknameRow, cycleId: string): NicknameConfirmation {
  return {
    guildId: row.guildId,
    discordUserId: row.discordUserId,
    cycleId,
    expectedAppliedNickname: row.pendingAppliedNickname,
    source: row.source,
    sourceId: row.sourceId,
    playerId: row.playerId,
    playerTag: row.playerTag,
    playerName: row.playerName,
    prefix: row.prefix,
  };
}

/**
 * Confirm that Discord accepted the write for exactly one management cycle.
 * The expected nickname prevents a stale pending row from being confirmed after
 * the member changed their nickname again.
 */
async function confirmNicknameApplied(
  input: NicknameConfirmation,
  db: SupabaseClient,
): Promise<boolean> {
  const result = await db.rpc('managed_nickname_mark_applied', {
    p_guild_id: input.guildId,
    p_discord_user_id: input.discordUserId,
    p_cycle_id: input.cycleId,
    p_source: input.source,
    p_source_id: input.sourceId,
    p_player_id: input.playerId,
    p_player_tag: input.playerTag,
    p_player_name: input.playerName,
    p_prefix: input.prefix,
    p_expected_applied_nickname: input.expectedAppliedNickname ?? null,
  });
  requireOk(result.error, 'Confirm managed nickname');
  return result.data === true;
}

/** Release only the exact current or pending cycle of one managed nickname. */
async function releaseNicknameCycle(
  guildId: string,
  discordUserId: string,
  cycleId: string,
  db: SupabaseClient,
): Promise<boolean> {
  if (cycleId === '') return false;
  const result = await db.rpc('managed_nickname_release', {
    p_guild_id: guildId,
    p_discord_user_id: discordUserId,
    p_cycle_id: cycleId,
  });
  requireOk(result.error, 'Release managed nickname');
  return result.data === true;
}

async function releaseLedgerOnly(
  guildId: string,
  discordUserId: string,
  db: SupabaseClient,
): Promise<boolean> {
  try {
    const row = await readManagedRow(guildId, discordUserId, db);
    if (row === null || row.releasedAt !== null) return false;
    return await releaseNicknameCycle(
      guildId,
      discordUserId,
      row.pendingCycleId ?? row.cycleId,
      db,
    );
  } catch (error) {
    logger.warn('Could not release a managed nickname ledger row', {
      guildId,
      discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Discord's "member not found" is final; other failures are transient. */
function isConfirmedMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const row = error as { code?: unknown; status?: unknown; httpStatus?: unknown; message?: unknown };
  const code = typeof row.code === 'string' || typeof row.code === 'number' ? String(row.code) : '';
  if (code === '10007') return true;
  if (row.status === 404 || row.httpStatus === 404) return true;
  const message = typeof row.message === 'string' ? row.message : '';
  return /unknown member/i.test(message);
}

async function fetchMemberForNickname(guild: Guild, discordUserId: string): Promise<MemberLookup> {
  try {
    const member = await guild.members.fetch(discordUserId);
    if (member === null || member === undefined) return { member: null, kind: 'not-member' };
    return { member, kind: 'ok' };
  } catch (error) {
    return {
      member: null,
      kind: isConfirmedMissing(error) ? 'not-member' : 'unresolved',
    };
  }
}

async function applyNicknameForMain(
  guild: Guild,
  discordUserId: string,
  main: RegisteredLinkView,
  settings: GuildNicknameSettings,
  source: NicknameSource,
  options: NicknameServiceOptions,
): Promise<NicknameSyncResult> {
  const db = dbFor(options);
  const desired = formatNickname(settings.prefix, main.name ?? 'BrawlHub member');

  if (guild.ownerId === discordUserId) {
    const released = await releaseLedgerOnly(guild.id, discordUserId, db);
    return { kind: 'skipped-owner', nickname: desired, released };
  }

  const lookup = await fetchMemberForNickname(guild, discordUserId);
  if (lookup.kind === 'unresolved') return { kind: 'unresolved', nickname: desired };
  if (lookup.member === null) {
    const released = await releaseLedgerOnly(guild.id, discordUserId, db);
    return { kind: 'not-member', nickname: desired, released };
  }
  if (lookup.member.user.bot) {
    const released = await releaseLedgerOnly(guild.id, discordUserId, db);
    return { kind: 'skipped-bot', nickname: desired, released };
  }

  const write: ManagedNicknameWrite = {
    guildId: guild.id,
    discordUserId,
    appliedNickname: desired,
    source,
    main,
    prefix: settings.prefix,
  };

  let row: ManagedNicknameRow | null;
  try {
    row = await readManagedRow(guild.id, discordUserId, db);
  } catch (error) {
    logger.warn('Could not read the managed nickname ledger before applying', {
      guildId: guild.id,
      discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed', nickname: desired };
  }

  // A prior Discord write whose confirmation failed can be recognized by the
  // exact pending nickname without sending a second request. Confirming it
  // must not report the new desired nickname as already applied: after a prefix
  // change the current pass continues below and writes that new nickname.
  if (
    row?.pendingCycleId !== null && row?.pendingCycleId !== undefined &&
    row.pendingAppliedNickname !== null &&
    lookup.member.nickname === row.pendingAppliedNickname
  ) {
    try {
      await confirmNicknameApplied(confirmationForRow(row, row.pendingCycleId), db);
    } catch (error) {
      logger.warn('Could not reconcile a pending managed nickname', {
        guildId: guild.id,
        discordUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'failed', nickname: desired };
    }
    row = await readManagedRow(guild.id, discordUserId, db);
  }

  // The desired nickname is already present. Only a confirmed active cycle can
  // claim it; a released row or an unrelated member choice stays untouched.
  if (lookup.member.nickname === desired) return { kind: 'unchanged', nickname: desired };

  const hasPendingIntent = row?.pendingCycleId !== null && row?.pendingCycleId !== undefined;
  const cycleId = hasPendingIntent ? row!.pendingCycleId! : randomUUID();
  const previousNickname = hasPendingIntent
    ? (row!.pendingPreviousNickname ?? lookup.member.nickname ?? null)
    : row !== null && row.releasedAt === null && row.confirmedAt !== null
      ? row.previousNickname
      : (lookup.member.nickname ?? null);

  try {
    await persistNicknameIntent(write, cycleId, previousNickname, db);
  } catch (error) {
    logger.warn('Could not persist a managed nickname intent', {
      guildId: guild.id,
      discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed', nickname: desired };
  }

  try {
    await lookup.member.setNickname(desired, NICKNAME_REASON);
  } catch (error) {
    logger.warn('Could not change a verified member nickname', {
      guildId: guild.id,
      discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed', nickname: desired };
  }

  try {
    if (!(await confirmNicknameApplied(
      confirmationForWrite(write, cycleId, desired),
      db,
    ))) {
      logger.warn('Managed nickname cycle was superseded before confirmation', {
        guildId: guild.id,
        discordUserId,
      });
      return { kind: 'failed', nickname: desired };
    }
  } catch (error) {
    logger.warn('Nickname changed but its ledger confirmation failed', {
      guildId: guild.id,
      discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed', nickname: desired };
  }
  return { kind: 'ok', nickname: desired };
}

/**
 * Set one verified member's server nickname from the currently linked guild main.
 * Failures are returned, never thrown, so verification and sync outcomes are
 * unaffected by Discord permission or hierarchy problems.
 */
export async function syncMemberNickname(
  guild: Guild,
  discordUserId: string,
  options: NicknameServiceOptions & {
    readonly playerNameHint?: NicknameHintInput;
    readonly settings?: GuildNicknameSettings;
    readonly source?: NicknameSource;
  } = {},
): Promise<NicknameSyncResult> {
  const parsedUserId = requireSnowflake(discordUserId, 'user');
  const settings = options.settings ?? (await loadGuildNicknameSettings(guild.id, options));
  if (!settings.enabled) return { kind: 'disabled' };

  const main = await resolveVerifiedGuildMain(
    guild.id,
    parsedUserId,
    options.playerNameHint ?? null,
    options,
  );
  if (main === null) return { kind: 'not-verified' };
  return applyNicknameForMain(
    guild,
    parsedUserId,
    main,
    settings,
    options.source ?? { source: 'manual' },
    options,
  );
}

function logNicknameHookResult(
  result: NicknameHookResult,
  guildId: string,
  discordUserId: string,
  source: string,
): void {
  if (result.kind === 'ok' || result.kind === 'unchanged' || result.kind === 'no-ledger') return;
  logger.warn('Nickname hook was not applied', {
    guildId,
    discordUserId,
    source,
    kind: result.kind,
  });
}

/** Best-effort nickname hook for a guild-scoped verification completion. */
export async function syncNicknameAfterVerification(
  client: Client,
  guildId: string,
  discordUserId: string,
  hint: NicknameHintInput = null,
  options: NicknameServiceOptions = {},
): Promise<NicknameSyncResult> {
  const guild = await client.guilds.fetch(guildId);
  const result = await syncMemberNickname(guild, discordUserId, {
    ...options,
    playerNameHint: hint,
    source: { source: 'verification' },
  });
  logNicknameHookResult(result, guildId, discordUserId, 'verification');
  return result;
}

/** Release one managed nickname when its link is gone or sync no longer applies. */
export async function releaseManagedNicknameForMember(
  guild: Guild,
  discordUserId: string,
  options: NicknameServiceOptions & {
    readonly row?: ManagedNicknameRow;
    readonly source?: NicknameSource;
  } = {},
): Promise<ManagedNicknameReleaseResult> {
  const parsedUserId = requireSnowflake(discordUserId, 'user');
  const db = dbFor(options);
  let row = options.row ?? (await readManagedRow(guild.id, parsedUserId, db));
  if (row === null || row.releasedAt !== null) return { kind: 'no-ledger' };

  let releaseCycle = row.pendingCycleId ?? row.cycleId;
  if (releaseCycle === '') return { kind: 'failed' };

  const lookup = await fetchMemberForNickname(guild, parsedUserId);
  if (lookup.kind === 'unresolved') return { kind: 'unresolved' };

  if (lookup.kind === 'not-member') {
    if (!(await releaseNicknameCycle(guild.id, parsedUserId, releaseCycle, db))) {
      return { kind: 'unchanged' };
    }
    return { kind: 'released', released: true, notMember: true };
  }

  // Never mutate the owner or a bot; just stop tracking the nickname.
  if (guild.ownerId === parsedUserId) {
    if (!(await releaseNicknameCycle(guild.id, parsedUserId, releaseCycle, db))) {
      return { kind: 'unchanged' };
    }
    return { kind: 'skipped-owner', released: true };
  }
  if (lookup.member === null || lookup.member.user.bot) {
    if (!(await releaseNicknameCycle(guild.id, parsedUserId, releaseCycle, db))) {
      return { kind: 'unchanged' };
    }
    return { kind: 'skipped-bot', released: true };
  }

  // A pending intent alone is not proof that BrawlHub changed the nickname.
  // An exact match with the stored pending nickname is the same evidence the
  // apply path uses; settle that cycle first so its captured previous nickname
  // can be restored instead of discarded.
  if (row.pendingCycleId !== null || row.confirmedAt === null) {
    const hasPendingProof =
      row.pendingCycleId !== null &&
      row.pendingAppliedNickname !== null &&
      lookup.member.nickname === row.pendingAppliedNickname;
    if (!hasPendingProof) {
      if (!(await releaseNicknameCycle(guild.id, parsedUserId, releaseCycle, db))) {
        return { kind: 'unchanged' };
      }
      return { kind: 'released', released: true };
    }

    try {
      if (!(await confirmNicknameApplied(
        confirmationForRow(row, row.pendingCycleId!),
        db,
      ))) {
        logger.warn('Could not settle a pending managed nickname before cleanup', {
          guildId: guild.id,
          discordUserId: parsedUserId,
        });
        return { kind: 'failed' };
      }
    } catch (error) {
      logger.warn('Could not settle a pending managed nickname before cleanup', {
        guildId: guild.id,
        discordUserId: parsedUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'failed' };
    }

    const refreshed = await readManagedRow(guild.id, parsedUserId, db);
    if (refreshed === null || refreshed.releasedAt !== null) return { kind: 'failed' };
    row = refreshed;
    releaseCycle = row.pendingCycleId ?? row.cycleId;
  }

  // A nickname changed by the member after our write is theirs; do not overwrite it.
  if (lookup.member.nickname !== row.appliedNickname) {
    if (!(await releaseNicknameCycle(guild.id, parsedUserId, releaseCycle, db))) {
      return { kind: 'unchanged' };
    }
    return { kind: 'unchanged', released: true };
  }

  try {
    await lookup.member.setNickname(row.previousNickname, NICKNAME_RELEASE_REASON);
  } catch (error) {
    logger.warn('Could not restore a previous member nickname', {
      guildId: guild.id,
      discordUserId: parsedUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed' };
  }
  if (!(await releaseNicknameCycle(guild.id, parsedUserId, releaseCycle, db))) {
    return { kind: 'failed' };
  }
  return { kind: 'released', released: true, restored: true };
}

/** Re-evaluate one member after a link mutation and either sync or release. */
export async function reconcileMemberNickname(
  guild: Guild,
  discordUserId: string,
  options: NicknameServiceOptions & { readonly source?: NicknameSource } = {},
): Promise<NicknameHookResult> {
  const parsedUserId = requireSnowflake(discordUserId, 'user');
  const db = dbFor(options);
  const settings = await loadGuildNicknameSettings(guild.id, { db });
  const source = options.source ?? { source: 'manual' };
  if (!settings.enabled) {
    return releaseManagedNicknameForMember(guild, parsedUserId, { db, source });
  }
  const main = await resolveVerifiedGuildMain(guild.id, parsedUserId, null, { db });
  if (main === null) {
    return releaseManagedNicknameForMember(guild, parsedUserId, { db, source });
  }
  return applyNicknameForMain(guild, parsedUserId, main, settings, source, { db });
}

/** Best-effort command-layer hook after set-main, staff link or unverify. */
export async function refreshGuildNicknameAfterLinkChange(
  client: Client,
  guildId: string,
  discordUserId: string,
  source: NicknameSource,
  options: NicknameServiceOptions = {},
): Promise<NicknameHookResult> {
  const guild = await client.guilds.fetch(guildId);
  const result = await reconcileMemberNickname(guild, discordUserId, { ...options, source });
  logNicknameHookResult(result, guildId, discordUserId, source.source);
  return result;
}

function aggregateSyncResult(summary: MutableSummary, result: NicknameSyncResult): void {
  if (result.released === true) summary.released += 1;
  switch (result.kind) {
    case 'ok':
      summary.updated += 1;
      break;
    case 'unchanged':
      summary.unchanged += 1;
      break;
    case 'not-member':
      summary.notMembers += 1;
      break;
    case 'unresolved':
      summary.unresolved += 1;
      summary.failures += 1;
      break;
    case 'failed':
      summary.failures += 1;
      break;
    default:
      break;
  }
}

function aggregateReleaseResult(summary: MutableSummary, result: ManagedNicknameReleaseResult): void {
  if (result.released === true) summary.released += 1;
  if (result.restored === true) summary.restored += 1;
  if (result.notMember === true) summary.notMembers += 1;
  if (result.kind === 'unresolved') summary.unresolved += 1;
  if (result.kind === 'unresolved' || result.kind === 'failed') summary.failures += 1;
  // A row that could not be released or restored must be retried by the
  // scheduled pass for disabled guilds; cleanup is not complete yet.
  if (
    result.kind === 'unresolved' ||
    result.kind === 'failed' ||
    result.released !== true
  ) {
    summary.cleanupIncomplete = true;
  }
}

/** Release managed nicknames that are no longer eligible, with Discord checks. */
export async function releaseManagedNicknamesInGuild(
  guild: Guild,
  options: NicknameServiceOptions & {
    readonly eligibleUserIds?: ReadonlySet<string>;
    readonly source?: NicknameSource;
  } = {},
): Promise<GuildNicknameSyncSummary> {
  const db = dbFor(options);
  const summary = emptySummary();
  let rows: ManagedNicknameRow[] = [];
  try {
    rows = await readActiveManagedRows(guild.id, db);
  } catch (error) {
    summary.failures += 1;
    summary.cleanupIncomplete = true;
    logger.warn('Could not read managed nicknames for cleanup', {
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }

  const source = options.source ?? { source: 'cleanup' };
  for (const row of rows) {
    if (options.eligibleUserIds?.has(row.discordUserId) === true) continue;
    try {
      const result = await releaseManagedNicknameForMember(guild, row.discordUserId, {
        db,
        row,
        source,
      });
      aggregateReleaseResult(summary, result);
    } catch (error) {
      summary.failures += 1;
      summary.cleanupIncomplete = true;
      logger.warn('Managed nickname cleanup failed for one member', {
        guildId: guild.id,
        discordUserId: row.discordUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}

/** Best-effort cleanup helper used by `/fn nickname disable`. */
export async function releaseManagedNicknamesAfterDisable(
  guild: Guild,
  options: NicknameServiceOptions = {},
): Promise<GuildNicknameSyncSummary> {
  const summary = await releaseManagedNicknamesInGuild(guild, {
    ...options,
    source: { source: 'disabled' },
  });
  if (summary.released > 0 || summary.failures > 0) {
    logger.warn('Managed nickname cleanup after disable finished', { ...summary });
  }
  return summary;
}

/** Refresh every verified main account in one guild. */
export async function refreshGuildNicknames(
  guild: Guild,
  options: NicknameServiceOptions & {
    readonly settings?: GuildNicknameSettings;
  } = {},
): Promise<GuildNicknameSyncSummary> {
  const db = dbFor(options);
  const summary = emptySummary(1);
  let settings: GuildNicknameSettings;
  try {
    settings = options.settings ?? (await loadGuildNicknameSettings(guild.id, { db }));
  } catch (error) {
    summary.failures += 1;
    logger.warn('Could not read nickname sync settings for guild refresh', {
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }

  let links: RegisteredLinkView[] = [];
  let linksReadOk = true;
  try {
    links = await listGuildVerifiedLinks(guild.id, { db });
  } catch (error) {
    linksReadOk = false;
    summary.failures += 1;
    logger.warn('Could not read guild verified links for nickname refresh', {
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // An unreadable link list makes `eligibleUserIds` untrustworthy. Cleanup must
  // not run in that case or it would release every managed nickname as stale.
  if (!linksReadOk) {
    summary.cleanupIncomplete = true;
    return summary;
  }

  const mains = settings.enabled ? selectEligibleGuildMains(links) : [];
  const eligibleUserIds = new Set<string>();
  for (const main of mains) {
    eligibleUserIds.add(main.discordUserId);
    try {
      const result = await applyNicknameForMain(
        guild,
        main.discordUserId,
        main,
        settings,
        { source: 'scheduled', sourceId: main.verificationId },
        { db },
      );
      aggregateSyncResult(summary, result);
    } catch (error) {
      summary.failures += 1;
      logger.warn('Nickname refresh failed for one member', {
        guildId: guild.id,
        discordUserId: main.discordUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  summary.members = mains.length;

  try {
    const cleanup = await releaseManagedNicknamesInGuild(guild, {
      db,
      eligibleUserIds,
      source: { source: 'scheduled-cleanup' },
    });
    summary.notMembers += cleanup.notMembers;
    summary.unresolved += cleanup.unresolved;
    summary.restored += cleanup.restored;
    summary.released += cleanup.released;
    summary.failures += cleanup.failures;
    summary.cleanupIncomplete = summary.cleanupIncomplete || cleanup.cleanupIncomplete;
  } catch (error) {
    summary.failures += 1;
    logger.warn('Managed nickname cleanup failed', {
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return summary;
}

/** Keyset pages of guilds that still have active managed nickname rows. */
async function readActiveNicknameGuildIds(db: SupabaseClient): Promise<string[]> {
  const guildIds: string[] = [];
  let afterGuildId: string | null = null;
  for (let page = 0; page < MAX_ACTIVE_GUILD_PAGES; page += 1) {
    const result = await db.rpc('guilds_with_active_managed_nicknames', {
      p_limit: ACTIVE_GUILD_PAGE_SIZE,
      p_after_guild_id: afterGuildId,
    });
    requireOk(result.error, 'Read guilds with active managed nicknames');
    const rows = Array.isArray(result.data) ? result.data : [];
    for (const value of rows) {
      const id = asString(record(value)?.['guild_id']);
      if (id !== null && SNOWFLAKE_PATTERN.test(id)) guildIds.push(id);
    }
    if (rows.length < ACTIVE_GUILD_PAGE_SIZE) return guildIds;
    const last = asString(record(rows[rows.length - 1])?.['guild_id']);
    if (last === null || last === afterGuildId) {
      throw new Error('Read active managed nickname guilds: missing keyset');
    }
    afterGuildId = last;
  }
  throw new Error('Read active managed nickname guilds: page limit exceeded');
}

function aggregateCleanupSummary(
  summary: MutableSummary,
  cleanup: GuildNicknameSyncSummary,
): void {
  summary.notMembers += cleanup.notMembers;
  summary.unresolved += cleanup.unresolved;
  summary.restored += cleanup.restored;
  summary.released += cleanup.released;
  summary.failures += cleanup.failures;
  summary.cleanupIncomplete = summary.cleanupIncomplete || cleanup.cleanupIncomplete;
}

/**
 * Refresh enabled guilds and retry cleanup for disabled guilds that still have
 * active ledger rows. A failed cleanup must stay visible until it succeeds.
 */
export async function refreshAllConfiguredNicknames(
  client: Client,
  options: NicknameServiceOptions = {},
): Promise<GuildNicknameSyncSummary> {
  const db = dbFor(options);
  const summary = emptySummary();
  let configuredGuildIds: string[] = [];
  try {
    const result = await db
      .from('guild_settings')
      .select('guild_id')
      .eq('nickname_sync_enabled', true);
    requireOk(result.error, 'Read guilds configured for nickname sync');
    configuredGuildIds = (result.data ?? [])
      .map((value: unknown) => asString(record(value)?.['guild_id']))
      .filter((id): id is string => id !== null && SNOWFLAKE_PATTERN.test(id));
  } catch (error) {
    summary.failures += 1;
    summary.cleanupIncomplete = true;
    logger.warn('Could not read guilds configured for nickname sync', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let activeGuildIds: string[] = [];
  try {
    activeGuildIds = await readActiveNicknameGuildIds(db);
  } catch (error) {
    summary.failures += 1;
    summary.cleanupIncomplete = true;
    logger.warn('Could not read guilds with active managed nicknames', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const enabled = new Set(configuredGuildIds);
  for (const guildId of new Set([...configuredGuildIds, ...activeGuildIds])) {
    try {
      const guild = await client.guilds.fetch(guildId);
      if (enabled.has(guildId)) {
        const guildSummary = await refreshGuildNicknames(guild, { db });
        summary.guilds += 1;
        summary.members += guildSummary.members;
        summary.updated += guildSummary.updated;
        summary.unchanged += guildSummary.unchanged;
        aggregateCleanupSummary(summary, guildSummary);
      } else {
        // The guild disabled sync but cleanup was incomplete. There is no
        // eligible-member set here: every active row must be released.
        const cleanup = await releaseManagedNicknamesInGuild(guild, {
          db,
          source: { source: 'scheduled-cleanup-disabled' },
        });
        summary.guilds += 1;
        aggregateCleanupSummary(summary, cleanup);
      }
    } catch (error) {
      summary.failures += 1;
      summary.cleanupIncomplete = true;
      logger.warn('Could not refresh configured guild nicknames', {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
