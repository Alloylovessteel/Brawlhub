import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client, Guild, GuildMember } from 'discord.js';
import { AdminServiceError, recordAdminAudit } from '../admin/service.js';
import type { AdminActor } from '../admin/types.js';
import { asString, record, requireOk } from '../clubs/service.js';
import { selectGuildMainLinks } from '../ranked-roles/service.js';
import { listGuildVerifiedLinks } from '../verification/service.js';

const logger = createLogger('bot/nickname-sync');
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const DISCORD_NICKNAME_LIMIT = 32;
const PREFIX_LIMIT = 16;
const NICKNAME_REASON = 'BrawlHub verified player nickname';

export interface NicknameServiceOptions {
  readonly db?: SupabaseClient;
}

export interface GuildNicknameSettings {
  readonly guildId: string;
  readonly enabled: boolean;
  readonly prefix: string | null;
}

export type NicknameSyncResult = {
  readonly kind:
    | 'ok'
    | 'unchanged'
    | 'disabled'
    | 'not-verified'
    | 'not-member'
    | 'skipped-owner'
    | 'skipped-bot'
    | 'failed';
  readonly nickname?: string;
};

export interface GuildNicknameSyncSummary {
  readonly guilds: number;
  readonly members: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly notMembers: number;
  readonly failures: number;
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

async function resolveVerifiedPlayerName(
  guildId: string,
  discordUserId: string,
  playerNameHint: string | null,
  options: NicknameServiceOptions,
): Promise<string | null> {
  const hinted = normalizePlayerName(playerNameHint);
  if (hinted !== null) return hinted;

  const links = await listGuildVerifiedLinks(guildId, options);
  const main = selectGuildMainLinks(links).find((link) => link.discordUserId === discordUserId);
  if (main === undefined) return null;
  const source = links.find(
    (link) => link.playerId === main.playerId && link.discordUserId === discordUserId,
  );
  return normalizePlayerName(source?.name ?? null);
}

/**
 * Set one verified member's server nickname from their linked Brawl Stars
 * player name. Failures are returned, never thrown, so verification and sync
 * outcomes are unaffected by Discord permission or hierarchy problems.
 */
export async function syncMemberNickname(
  guild: Guild,
  discordUserId: string,
  options: NicknameServiceOptions & {
    readonly playerNameHint?: string | null;
  } = {},
): Promise<NicknameSyncResult> {
  const parsedUserId = requireSnowflake(discordUserId, 'user');
  const settings = await loadGuildNicknameSettings(guild.id, options);
  if (!settings.enabled) return { kind: 'disabled' };

  const playerName = await resolveVerifiedPlayerName(
    guild.id,
    parsedUserId,
    options.playerNameHint ?? null,
    options,
  );
  if (playerName === null) return { kind: 'not-verified' };

  const desired = formatNickname(settings.prefix, playerName);
  if (guild.ownerId === parsedUserId) return { kind: 'skipped-owner', nickname: desired };

  let member: GuildMember | null;
  try {
    member = await guild.members.fetch(parsedUserId);
  } catch {
    return { kind: 'not-member', nickname: desired };
  }
  if (member === null) return { kind: 'not-member', nickname: desired };
  if (member.user.bot) return { kind: 'skipped-bot', nickname: desired };
  if (member.nickname === desired) return { kind: 'unchanged', nickname: desired };

  try {
    await member.setNickname(desired, NICKNAME_REASON);
  } catch (error) {
    logger.warn('Could not change a verified member nickname', {
      guildId: guild.id,
      discordUserId: parsedUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed', nickname: desired };
  }
  return { kind: 'ok', nickname: desired };
}

/** Best-effort nickname hook for a guild-scoped verification completion. */
export async function syncNicknameAfterVerification(
  client: Client,
  guildId: string,
  discordUserId: string,
  playerName: string,
): Promise<NicknameSyncResult> {
  const guild = await client.guilds.fetch(guildId);
  return syncMemberNickname(guild, discordUserId, { playerNameHint: playerName });
}

/** Refresh every verified main account in one guild. */
export async function refreshGuildNicknames(
  guild: Guild,
  options: NicknameServiceOptions = {},
): Promise<GuildNicknameSyncSummary> {
  const links = await listGuildVerifiedLinks(guild.id, options);
  const mains = selectGuildMainLinks(links);
  let updated = 0;
  let unchanged = 0;
  let notMembers = 0;
  let failures = 0;

  for (const main of mains) {
    const link = links.find(
      (candidate) =>
        candidate.playerId === main.playerId && candidate.discordUserId === main.discordUserId,
    );
    const result = await syncMemberNickname(guild, main.discordUserId, {
      ...options,
      playerNameHint: link?.name ?? null,
    });
    if (result.kind === 'ok') updated += 1;
    else if (result.kind === 'unchanged') unchanged += 1;
    else if (result.kind === 'not-member') notMembers += 1;
    else if (result.kind !== 'disabled' && result.kind !== 'not-verified') failures += 1;
  }

  return {
    guilds: 1,
    members: mains.length,
    updated,
    unchanged,
    notMembers,
    failures,
  };
}

/** Refresh every guild that has automatic nickname sync enabled. */
export async function refreshAllConfiguredNicknames(
  client: Client,
  options: NicknameServiceOptions = {},
): Promise<GuildNicknameSyncSummary> {
  const db = dbFor(options);
  const result = await db
    .from('guild_settings')
    .select('guild_id')
    .eq('nickname_sync_enabled', true);
  requireOk(result.error, 'Read guilds configured for nickname sync');

  const guildIds = (result.data ?? [])
    .map((value: unknown) => asString(record(value)?.['guild_id']))
    .filter((id): id is string => id !== null && SNOWFLAKE_PATTERN.test(id));

  const summary: { -readonly [K in keyof GuildNicknameSyncSummary]: number } = {
    guilds: 0,
    members: 0,
    updated: 0,
    unchanged: 0,
    notMembers: 0,
    failures: 0,
  };

  for (const guildId of new Set(guildIds)) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const guildSummary = await refreshGuildNicknames(guild, { db });
      summary.guilds += 1;
      summary.members += guildSummary.members;
      summary.updated += guildSummary.updated;
      summary.unchanged += guildSummary.unchanged;
      summary.notMembers += guildSummary.notMembers;
      summary.failures += guildSummary.failures;
    } catch (error) {
      summary.failures += 1;
      logger.warn('Could not refresh configured guild nicknames', {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
