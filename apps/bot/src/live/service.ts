import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { BrawlStarsClient } from '@brawlhub/brawl-stars';
import { collectBattleLogs, type CollectedBattleLog } from '@brawlhub/sync';
import {
  EmbedBuilder,
  type Client,
  type TextBasedChannel,
} from 'discord.js';
import { loadPlayerHistory } from '../players/service.js';
import {
  getSharedBrawlStarsClient,
  readOfficialCachePolicy,
} from '../api/gateway.js';

/**
 * Opt-in live battle tracking. One official battle-log call is shared by every
 * guild subscribing to the same player; all writes and Discord posts are
 * scoped to the guild/channel stored on the subscription row.
 */

const logger = createLogger('bot');
const MAX_SESSION_MS = 3 * 60 * 60_000;
const IDLE_SESSION_MS = 60 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const PLAYER_CHUNK_SIZE = 100;
const MAX_ERROR_LENGTH = 1000;

type Db = ReturnType<typeof createTrustedClient>;

interface SubscriptionRow {
  readonly id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly discord_user_id: string;
  readonly profile_id: string | null;
  readonly player_id: string;
  readonly started_at: string;
  readonly last_battle_seen_at: string | null;
  readonly expires_at: string;
}

interface PlayerRow {
  readonly id: string;
  readonly tag: string;
  readonly last_battle_at: string | null;
}

interface ParsedBattle {
  readonly key: string;
  readonly battleTime: string;
  readonly mode: string | null;
  readonly map: string | null;
  readonly battleType: string | null;
  readonly result: string | null;
  readonly trophyChange: number | null;
  readonly raw: Record<string, unknown>;
}

export interface LivePollOptions {
  /** Injected for isolated tests. Defaults to the trusted Supabase client. */
  readonly db?: Db;
  /** Injected for isolated tests. Defaults to the shared official client. */
  readonly api?: BrawlStarsClient;
  readonly now?: Date;
}

export interface LivePollOutcome {
  readonly activeSubscriptions: number;
  readonly expiredSubscriptions: number;
  readonly playersPolled: number;
  readonly newBattles: number;
  readonly delivered: number;
  readonly failedPlayers: number;
}

type PollStatus = 'completed' | 'failed' | 'skipped';

type MutableLivePollOutcome = {
  -readonly [Key in keyof LivePollOutcome]: LivePollOutcome[Key];
};

let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollRunning = false;

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= MAX_ERROR_LENGTH ? cleaned : `${cleaned.slice(0, MAX_ERROR_LENGTH - 3)}...`;
}

function readPollIntervalMs(): number {
  const raw = process.env.LIVE_BATTLE_POLL_INTERVAL_MS?.trim();
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(parsed)));
}

function readTimeoutMs(): number {
  try {
    const policy = readOfficialCachePolicy();
    return policy.timeoutMs > 0 ? policy.timeoutMs : 15_000;
  } catch {
    return 15_000;
  }
}

export interface LiveTrackingStartInput {
  readonly guildId: string | null;
  readonly channelId: string;
  readonly discordUserId: string;
  readonly tag: string;
  readonly now?: Date | undefined;
  readonly db?: Db | undefined;
}

export type LiveTrackingStartResult =
  | {
      readonly kind: 'ok';
      readonly playerId: string;
      readonly playerTag: string;
      readonly expiresAt: string;
      readonly sessionMs: number;
    }
  | { readonly kind: 'guild-required' }
  | { readonly kind: 'invalid-tag' }
  | { readonly kind: 'not-found'; readonly tag: string }
  | { readonly kind: 'lookup-error' };

/** Opt a guild/channel/user into live delivery for one stored, guild-visible player. */
export async function startLiveTracking(
  input: LiveTrackingStartInput,
): Promise<LiveTrackingStartResult> {
  if (input.guildId === null || input.guildId.trim() === '') return { kind: 'guild-required' };
  const db = input.db ?? createTrustedClient();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + MAX_SESSION_MS).toISOString();

  const player = await loadPlayerHistory(
    { tag: input.tag, period: '7d', guildId: input.guildId, now },
    { db },
  );
  if (player.kind === 'invalid-tag') return { kind: 'invalid-tag' };
  if (player.kind === 'not-found') return { kind: 'not-found', tag: player.tag };
  if (player.kind !== 'ok') return { kind: 'lookup-error' };
  const playerId = player.value.player.id;
  if (playerId === null) return { kind: 'lookup-error' };

  let profileId: string | null = null;
  try {
    const { data: profileRows } = await db
      .from('profiles')
      .select('id')
      .eq('discord_user_id', input.discordUserId)
      .limit(1);
    const profile = Array.isArray(profileRows) ? profileRows[0] : null;
    const id = (profile as { id?: unknown } | null)?.id;
    if (typeof id === 'string') profileId = id;
  } catch {
    profileId = null;
  }

  const key = {
    guild_id: input.guildId,
    channel_id: input.channelId,
    discord_user_id: input.discordUserId,
    player_id: playerId,
  };
  const { data: existingRows, error: existingError } = await db
    .from('guild_live_subscriptions')
    .select('id')
    .eq('guild_id', key.guild_id)
    .eq('channel_id', key.channel_id)
    .eq('discord_user_id', key.discord_user_id)
    .eq('player_id', key.player_id)
    .limit(1);
  if (existingError) {
    logger.warn('Could not read an existing live subscription', {
      guildId: key.guild_id,
      reason: existingError.message,
    });
    return { kind: 'lookup-error' };
  }

  const existing = (Array.isArray(existingRows) ? existingRows[0] : null) as {
    id?: unknown;
  } | null;
  if (typeof existing?.id === 'string') {
    const { error } = await db
      .from('guild_live_subscriptions')
      .update({ active: true, expires_at: expiresAt })
      .eq('guild_id', key.guild_id)
      .eq('channel_id', key.channel_id)
      .eq('discord_user_id', key.discord_user_id)
      .eq('player_id', key.player_id);
    if (error) {
      logger.warn('Could not renew a live subscription', {
        guildId: key.guild_id,
        reason: error.message,
      });
      return { kind: 'lookup-error' };
    }
  } else {
    const { error } = await db.from('guild_live_subscriptions').insert({
      ...key,
      id: randomUUID(),
      profile_id: profileId,
      active: true,
      started_at: nowIso,
      last_battle_seen_at: null,
      expires_at: expiresAt,
    });
    if (error) {
      logger.warn('Could not create a live subscription', {
        guildId: key.guild_id,
        reason: error.message,
      });
      return { kind: 'lookup-error' };
    }
  }

  return {
    kind: 'ok',
    playerId,
    playerTag: player.value.player.tag,
    expiresAt,
    sessionMs: MAX_SESSION_MS,
  };
}

export interface LiveTrackingStopInput {
  readonly guildId: string | null;
  readonly channelId: string;
  readonly discordUserId: string;
  readonly tag?: string | undefined;
  readonly db?: Db | undefined;
}

export type LiveTrackingStopResult =
  | { readonly kind: 'ok'; readonly stopped: number }
  | { readonly kind: 'guild-required' }
  | { readonly kind: 'not-found'; readonly tag: string }
  | { readonly kind: 'lookup-error' };

/** Stop live delivery in this guild/channel, optionally limited to one player tag. */
export async function stopLiveTracking(
  input: LiveTrackingStopInput,
): Promise<LiveTrackingStopResult> {
  if (input.guildId === null || input.guildId.trim() === '') return { kind: 'guild-required' };
  const db = input.db ?? createTrustedClient();

  let query = db
    .from('guild_live_subscriptions')
    .delete()
    .eq('guild_id', input.guildId)
    .eq('channel_id', input.channelId)
    .eq('discord_user_id', input.discordUserId);
  if (input.tag !== undefined && input.tag.trim() !== '') {
    const player = await loadPlayerHistory(
      { tag: input.tag, period: '7d', guildId: input.guildId },
      { db },
    );
    if (player.kind === 'not-found') return { kind: 'not-found', tag: player.tag };
    if (player.kind !== 'ok' || player.value.player.id === null) {
      return { kind: 'lookup-error' };
    }
    query = query.eq('player_id', player.value.player.id);
  }

  const { data, error } = await query.select('player_id');
  if (error) {
    logger.warn('Could not stop live subscriptions', {
      guildId: input.guildId,
      reason: error.message,
    });
    return { kind: 'lookup-error' };
  }
  return { kind: 'ok', stopped: Array.isArray(data) ? data.length : 0 };
}

/** Stop the live battle scheduler. Safe to call even when it was never started. */
export function stopLiveBattleSchedule(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** Start the scheduler and return a stop function; never starts two timers. */
export function startLiveBattleSchedule(client: Client): () => void {
  stopLiveBattleSchedule();
  const intervalMs = readPollIntervalMs();
  pollTimer = setInterval(() => {
    void runScheduledPoll(client);
  }, intervalMs);
  logger.info('Live battle schedule enabled', { intervalMs });
  return () => stopLiveBattleSchedule();
}

async function runScheduledPoll(client: Client): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    await runLiveBattlePoll(client);
  } catch (error) {
    logger.warn('Live battle poll failed', { error: safeError(error) });
  } finally {
    pollRunning = false;
  }
}

function isExpired(row: SubscriptionRow, nowMs: number): boolean {
  if (Date.parse(row.expires_at) <= nowMs) return true;
  if (Date.parse(row.started_at) <= nowMs - MAX_SESSION_MS) return true;
  if (row.last_battle_seen_at === null) return false;
  const lastSeenMs = Date.parse(row.last_battle_seen_at);
  return !Number.isNaN(lastSeenMs) && lastSeenMs <= nowMs - IDLE_SESSION_MS;
}

async function deactivateSubscription(db: Db, row: SubscriptionRow): Promise<void> {
  const { error } = await db
    .from('guild_live_subscriptions')
    .update({ active: false })
    .eq('guild_id', row.guild_id)
    .eq('channel_id', row.channel_id)
    .eq('discord_user_id', row.discord_user_id)
    .eq('player_id', row.player_id);
  if (error) {
    logger.warn('Could not expire a live subscription', {
      guildId: row.guild_id,
      reason: error.message,
    });
  }
}

async function readPlayerRows(db: Db, ids: readonly string[]): Promise<PlayerRow[]> {
  const rows: PlayerRow[] = [];
  for (let index = 0; index < ids.length; index += PLAYER_CHUNK_SIZE) {
    const chunk = [...ids.slice(index, index + PLAYER_CHUNK_SIZE)];
    if (chunk.length === 0) continue;
    const { data, error } = await db
      .from('players')
      .select('id, tag, last_battle_at')
      .in('id', chunk);
    if (error) {
      logger.warn('Could not read live subscription players', { reason: error.message });
      continue;
    }
    for (const value of data ?? []) {
      const row = value as PlayerRow | null;
      if (row !== null && typeof row.id === 'string' && typeof row.tag === 'string') rows.push(row);
    }
  }
  return rows;
}

async function insertPoll(
  db: Db,
  row: {
    readonly guild_id: string;
    readonly player_id: string;
    readonly status: PollStatus;
    readonly last_battle_at_before: string | null;
    readonly new_battles?: number;
    readonly last_error?: string | null;
  },
): Promise<void> {
  const { error } = await db.from('live_battle_polls').insert(row);
  if (error) {
    logger.warn('Could not record a live battle poll', {
      guildId: row.guild_id,
      reason: error.message,
    });
  }
}

async function readDeliveredKeys(
  db: Db,
  row: SubscriptionRow,
  playerId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const delivered = new Set<string>();
  for (let index = 0; index < keys.length; index += PLAYER_CHUNK_SIZE) {
    const chunk = [...keys.slice(index, index + PLAYER_CHUNK_SIZE)];
    const { data, error } = await db
      .from('live_battle_deliveries')
      .select('battle_key')
      .eq('guild_id', row.guild_id)
      .eq('subscription_id', row.id)
      .eq('player_id', playerId)
      .in('battle_key', chunk);
    if (error) {
      logger.warn('Could not read live battle delivery ledger', {
        guildId: row.guild_id,
        reason: error.message,
      });
      return new Set<string>();
    }
    for (const value of data ?? []) {
      const key = (value as { battle_key?: unknown } | null)?.battle_key;
      if (typeof key === 'string') delivered.add(key);
    }
  }
  return delivered;
}

function buildBattleEmbed(battle: ParsedBattle, tag: string): EmbedBuilder {
  const mode = battle.mode ?? 'Unknown mode';
  const description = [
    `Player: \`#${tag}\``,
    ...(battle.map === null ? [] : [`Map: ${battle.map}`]),
    ...(battle.result === null ? [] : [`Result: ${battle.result}`]),
  ].join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x8f82ff)
    .setTitle(`New battle · ${mode}`)
    .setDescription(description)
    .setTimestamp(new Date(battle.battleTime))
    .setFooter({ text: 'Official Brawl Stars battle log' });
  if (battle.trophyChange !== null) {
    const sign = battle.trophyChange > 0 ? '+' : '';
    embed.addFields({ name: 'Trophies', value: `${sign}${battle.trophyChange}`, inline: true });
  }
  if (battle.battleType !== null) {
    embed.addFields({ name: 'Type', value: battle.battleType, inline: true });
  }
  return embed;
}

/** Resolve a channel only when it is still the exact guild channel stored on the subscription. */
async function resolveSubscriptionChannel(
  client: Client,
  row: SubscriptionRow,
): Promise<TextBasedChannel | null> {
  try {
    const channel = await client.channels.fetch(row.channel_id);
    if (channel === null || !channel.isTextBased()) return null;
    if (channel.id !== row.channel_id) return null;
    const guildId =
      'guildId' in channel
        ? channel.guildId
        : 'guild' in channel
          ? (channel.guild as { id?: string } | null)?.id
          : undefined;
    if (guildId !== row.guild_id) return null;
    return typeof (channel as { send?: unknown }).send === 'function'
      ? (channel as TextBasedChannel)
      : null;
  } catch {
    return null;
  }
}

async function deliverBattles(
  client: Client,
  db: Db,
  row: SubscriptionRow,
  playerId: string,
  tag: string,
  battles: readonly ParsedBattle[],
  nowIso: string,
): Promise<number> {
  if (battles.length === 0) return 0;
  const deliveredKeys = await readDeliveredKeys(
    db,
    row,
    playerId,
    battles.map((battle) => battle.key),
  );
  const pending = battles.filter((battle) => !deliveredKeys.has(battle.key));
  if (pending.length === 0) return 0;

  const channel = await resolveSubscriptionChannel(client, row);
  if (channel === null) return 0;
  const sendable = channel as unknown as { send: (payload: unknown) => Promise<{ id: string }> };

  let delivered = 0;
  for (const battle of pending) {
    try {
      const message = await sendable.send({
        embeds: [buildBattleEmbed(battle, tag)],
        allowedMentions: { parse: [] },
      });
      const { error } = await db.from('live_battle_deliveries').upsert(
        {
          guild_id: row.guild_id,
          subscription_id: row.id,
          player_id: playerId,
          battle_key: battle.key,
          discord_message_id: message.id,
          delivered_at: nowIso,
        },
        {
          onConflict: 'guild_id,subscription_id,player_id,battle_key',
          ignoreDuplicates: true,
        },
      );
      if (error) {
        logger.warn('Could not record a live battle delivery', {
          guildId: row.guild_id,
          reason: error.message,
        });
        continue;
      }
      delivered += 1;
    } catch (error) {
      logger.warn('Could not post a live battle embed', {
        guildId: row.guild_id,
        channelId: row.channel_id,
        error: safeError(error),
      });
    }
  }

  const { error: seenError } = await db
    .from('guild_live_subscriptions')
    .update({ last_battle_seen_at: nowIso })
    .eq('guild_id', row.guild_id)
    .eq('channel_id', row.channel_id)
    .eq('discord_user_id', row.discord_user_id)
    .eq('player_id', playerId);
  if (seenError) {
    logger.warn('Could not refresh live subscription idle timestamp', {
      guildId: row.guild_id,
      reason: seenError.message,
    });
  }
  return delivered;
}

/** Poll all active subscriptions, sharing one official battle-log call per player. */
export async function runLiveBattlePoll(
  client: Client,
  options: LivePollOptions = {},
): Promise<LivePollOutcome> {
  const db = options.db ?? createTrustedClient();
  const api = options.api ?? getSharedBrawlStarsClient();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const timeoutMs = readTimeoutMs();
  const outcome: MutableLivePollOutcome = {
    activeSubscriptions: 0,
    expiredSubscriptions: 0,
    playersPolled: 0,
    newBattles: 0,
    delivered: 0,
    failedPlayers: 0,
  };

  const { data: rawSubscriptions, error: subscriptionError } = await db
    .from('guild_live_subscriptions')
    .select(
      'id, guild_id, channel_id, discord_user_id, profile_id, player_id, started_at, last_battle_seen_at, expires_at',
    )
    .eq('active', true)
    .gt('expires_at', nowIso);

  if (subscriptionError) {
    logger.warn('Could not read active live subscriptions', { reason: subscriptionError.message });
    return outcome;
  }

  const groups = new Map<string, SubscriptionRow[]>();
  for (const value of rawSubscriptions ?? []) {
    const row = value as SubscriptionRow | null;
    if (row === null || typeof row.id !== 'string' || typeof row.player_id !== 'string') continue;
    if (isExpired(row, now.getTime())) {
      await deactivateSubscription(db, row);
      outcome.expiredSubscriptions += 1;
      continue;
    }
    const group = groups.get(row.player_id) ?? [];
    group.push(row);
    groups.set(row.player_id, group);
    outcome.activeSubscriptions += 1;
  }

  if (groups.size === 0) return outcome;
  const players = await readPlayerRows(db, [...groups.keys()]);
  const playersById = new Map(players.map((player) => [player.id, player]));

  for (const [playerId, subscriptions] of groups) {
    const player = playersById.get(playerId);
    if (player === undefined) {
      for (const row of subscriptions) {
        await insertPoll(db, {
          guild_id: row.guild_id,
          player_id: playerId,
          status: 'failed',
          last_battle_at_before: null,
          last_error: 'Subscribed player is no longer stored',
        });
      }
      outcome.failedPlayers += 1;
      continue;
    }

    const before = player.last_battle_at;
    const fresh: CollectedBattleLog[] = [];
    let firstError: unknown;
    let collectionFailed = false;

    try {
      await collectBattleLogs(
        db,
        api,
        [{ playerId, tag: player.tag }],
        null,
        timeoutMs,
        {
          onCollected: (battle) => fresh.push(battle),
          onError: (input) => {
            collectionFailed = true;
            firstError ??= input.error;
          },
        },
      );
    } catch (error) {
      collectionFailed = true;
      firstError ??= error;
    }

    if (collectionFailed) {
      for (const row of subscriptions) {
        await insertPoll(db, {
          guild_id: row.guild_id,
          player_id: playerId,
          status: 'failed',
          last_battle_at_before: before,
          last_error: safeError(firstError ?? new Error('Live battle collection failed')),
        });
      }
      outcome.failedPlayers += 1;
      continue;
    }

    for (const row of subscriptions) {
      await insertPoll(db, {
        guild_id: row.guild_id,
        player_id: playerId,
        status: 'completed',
        last_battle_at_before: before,
        new_battles: fresh.length,
      });
      outcome.delivered += await deliverBattles(
        client,
        db,
        row,
        playerId,
        player.tag,
        fresh,
        nowIso,
      );
    }
    outcome.playersPolled += 1;
    outcome.newBattles += fresh.length;
  }

  return outcome;
}
