import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { loadGuildSettings } from '../../admin/service';
import { getBotConfig } from '../../config';
import { isDefinitiveDiscordRejection } from '../../discord/errors';
import { loadClubSummaries } from '../service';
import { buildClubOverviewEmbeds, buildClubOverviewSelect } from './embed';
import { normalizeOverviewFields } from './fields';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const OVERVIEW_INITIAL_DELAY_MS = 15_000;
/** Page size below PostgREST's max_rows so large bot fleets cannot truncate discovery. */
const OVERVIEW_PAGE_SIZE = 1000;
const MAX_OVERVIEW_PAGES = 100;
/** A reserved overview claim may be reclaimed only before Discord was called. */
const OVERVIEW_CLAIM_PREFIX = 'claim:';
const OVERVIEW_CLAIM_STALE_MS = 10 * 60_000;

interface OverviewClaim {
  readonly claimId: string;
  readonly stage: 'reserved' | 'posting';
  readonly claimedAt: number;
  readonly previousMessageId: string | null;
}

function overviewClaimMessageId(
  claimId: string,
  stage: OverviewClaim['stage'],
  claimedAt: number,
  previousMessageId: string | null,
): string {
  return `${OVERVIEW_CLAIM_PREFIX}${claimId}:${stage}:${claimedAt}:${previousMessageId ?? ''}`;
}

function parseOverviewClaim(value: string | null): OverviewClaim | null {
  if (value === null || !value.startsWith(OVERVIEW_CLAIM_PREFIX)) return null;
  const parts = value.slice(OVERVIEW_CLAIM_PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [claimId, rawStage, rawClaimedAt, rawPrevious] = parts;
  if (claimId === undefined || claimId === '') return null;
  if (rawStage !== 'reserved' && rawStage !== 'posting') return null;
  const claimedAt = rawClaimedAt === undefined ? Number.NaN : Number(rawClaimedAt);
  if (!Number.isFinite(claimedAt)) return null;
  return {
    claimId,
    stage: rawStage,
    claimedAt,
    previousMessageId: rawPrevious === undefined || rawPrevious === '' ? null : rawPrevious,
  };
}

/** Any claim sentinel, including an unparseable legacy `claim:<id>`, is uncertain. */
function isOverviewClaimSentinel(value: string | null): boolean {
  return value !== null && value.startsWith(OVERVIEW_CLAIM_PREFIX);
}

export interface OverviewTarget {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string | null;
  /** Raw claim sentinel, when the stored overview ID is not a Discord message ID. */
  readonly claimMessageId: string | null;
  readonly fields: readonly string[];
}

/** Read every guild that has opted in to the auto-updating overview, in guild-id pages. */
export async function readOverviewTargets(): Promise<OverviewTarget[]> {
  const db = createTrustedClient();
  const targets: OverviewTarget[] = [];
  const seenGuildIds = new Set<string>();
  let afterGuildId: string | null = null;
  const nowMs = Date.now();

  for (let page = 0; page < MAX_OVERVIEW_PAGES; page += 1) {
    let query = db
      .from('guild_settings')
      .select('guild_id, overview_channel_id, overview_message_id, overview_fields')
      .not('overview_channel_id', 'is', null)
      .order('guild_id', { ascending: true })
      .limit(OVERVIEW_PAGE_SIZE);
    if (afterGuildId !== null) query = query.gt('guild_id', afterGuildId);
    const result = await query;
    if (result.error !== null) {
      throw new Error(`Read overview guilds failed: ${result.error.message}`);
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    for (const raw of rows) {
      const guildId = typeof raw['guild_id'] === 'string' ? raw['guild_id'] : null;
      const channelId = typeof raw['overview_channel_id'] === 'string' ? raw['overview_channel_id'] : null;
      if (guildId === null || channelId === null || seenGuildIds.has(guildId)) continue;
      seenGuildIds.add(guildId);

      const storedMessageId =
        typeof raw['overview_message_id'] === 'string' ? raw['overview_message_id'] : null;
      const claimSentinel = isOverviewClaimSentinel(storedMessageId);
      const claim = parseOverviewClaim(storedMessageId);
      let messageId = storedMessageId;
      if (claim !== null) {
        // A posting claim may already have produced a Discord message, so it is
        // never recovered automatically. Only a stale pre-send claim is reusable.
        messageId =
          claim.stage === 'reserved' && nowMs - claim.claimedAt > OVERVIEW_CLAIM_STALE_MS
            ? claim.previousMessageId
            : null;
      } else if (claimSentinel) {
        // A legacy claim has no safe stage or timestamp; never treat it as a
        // real Discord message ID or repost it automatically.
        messageId = null;
      }
      targets.push({
        guildId,
        channelId,
        messageId,
        claimMessageId: claimSentinel ? storedMessageId : null,
        fields: normalizeOverviewFields(raw['overview_fields']),
      });
    }

    if (rows.length < OVERVIEW_PAGE_SIZE) break;
    const lastGuildId = rows.reduce<string | null>(
      (last, raw) => (typeof raw['guild_id'] === 'string' ? raw['guild_id'] : last),
      null,
    );
    if (lastGuildId === null || lastGuildId === afterGuildId) break;
    afterGuildId = lastGuildId;
  }
  return targets;
}

async function compareAndSetOverviewMessageId(
  guildId: string,
  expectedMessageId: string | null,
  nextMessageId: string | null,
): Promise<boolean> {
  const db = createTrustedClient();
  let query = db
    .from('guild_settings')
    .update({ overview_message_id: nextMessageId })
    .eq('guild_id', guildId);
  query = expectedMessageId === null
    ? query.is('overview_message_id', null)
    : query.eq('overview_message_id', expectedMessageId);
  const result = await query.select('guild_id');
  if (result.error !== null) {
    throw new Error(`Save overview message ID failed: ${result.error.message}`);
  }
  return (result.data ?? []).length > 0;
}

function safeError(error: unknown, token: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  return token !== undefined && token.length > 0 && message.includes(token)
    ? message.split(token).join(REDACTED)
    : message;
}

function isUnknownMessage(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.code === 10008 || candidate.status === 404;
}

export interface PostOverviewInput {
  readonly rest: REST;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string | null;
  /** Raw claim sentinel read from settings, when the stored ID is not a Discord message. */
  readonly claimMessageId?: string | null;
  readonly guildLabel: string | null;
  readonly guildIconUrl?: string | null;
  readonly fields: readonly string[];
  readonly token: string | undefined;
}

async function buildOverviewRequest(input: PostOverviewInput): Promise<Record<string, unknown>> {
  const config = getBotConfig();
  const summaries = await loadClubSummaries(input.guildId);
  const embeds = buildClubOverviewEmbeds({
    summaries,
    guildLabel: input.guildLabel,
    now: new Date(),
    config,
    fields: input.fields,
    guildIconUrl: input.guildIconUrl,
  });
  const select = buildClubOverviewSelect(summaries, input.guildId, input.fields);
  return {
    embeds: embeds.map((embed) => embed.toJSON()),
    components: select === null ? [] : [select],
    allowed_mentions: { parse: [] },
    flags: 0,
  };
}

/** Post a fresh overview, deleting the previous message only after the new one succeeds. */
async function sendOverviewRequest(
  input: PostOverviewInput,
  body: Record<string, unknown>,
): Promise<string | null> {
  const message = (await input.rest.post(Routes.channelMessages(input.channelId), {
    body,
  })) as { id?: string } | undefined;
  const messageId = message?.id ?? null;
  if (messageId === null) {
    logger.warn('Club overview post returned no message ID', { guildId: input.guildId });
    return null;
  }

  if (input.messageId !== null && input.messageId !== messageId) {
    try {
      await input.rest.delete(Routes.channelMessage(input.channelId, input.messageId));
    } catch (error: unknown) {
      if (!isUnknownMessage(error)) {
        logger.warn('Could not delete previous club overview message', {
          guildId: input.guildId,
          messageId: input.messageId,
          error: safeError(error, input.token),
        });
      }
    }
  }

  return messageId;
}

/** Post a fresh overview, deleting the previous message only after the new one succeeds. */
export async function postOverviewForGuild(input: PostOverviewInput): Promise<string | null> {
  try {
    const body = await buildOverviewRequest(input);
    return await sendOverviewRequest(input, body);
  } catch (error: unknown) {
    logger.error('Failed to post club overview', {
      guildId: input.guildId,
      channelId: input.channelId,
      error: safeError(error, input.token),
    });
    return null;
  }
}

/**
 * Stage a durable claim before calling Discord. Only an explicit Discord
 * rejection releases the claim; a timeout or network failure keeps it so a
 * later process cannot post a second overview for the same refresh.
 */
async function postOverviewWithClaim(input: PostOverviewInput): Promise<{
  readonly posted: boolean;
  readonly messageId: string | null;
}> {
  const claimId = randomUUID();
  const nowMs = Date.now();
  let expectedMessageId = input.messageId;
  const claimSentinel = isOverviewClaimSentinel(input.claimMessageId ?? null);
  const staleClaim = claimSentinel ? parseOverviewClaim(input.claimMessageId ?? null) : null;
  if (claimSentinel) {
    if (
      staleClaim === null ||
      staleClaim.stage !== 'reserved' ||
      nowMs - staleClaim.claimedAt <= OVERVIEW_CLAIM_STALE_MS
    ) {
      logger.warn('Club overview has an uncertain claim; leaving it for reconciliation', {
        guildId: input.guildId,
        claimId: staleClaim?.claimId ?? 'legacy',
      });
      return { posted: false, messageId: null };
    }
    expectedMessageId = input.claimMessageId ?? null;
  }

  const reserved = overviewClaimMessageId(claimId, 'reserved', nowMs, input.messageId);
  if (!(await compareAndSetOverviewMessageId(input.guildId, expectedMessageId, reserved))) {
    logger.warn('Club overview was changed by another writer; refresh skipped', {
      guildId: input.guildId,
    });
    return { posted: false, messageId: null };
  }

  const posting = overviewClaimMessageId(claimId, 'posting', nowMs, input.messageId);
  if (!(await compareAndSetOverviewMessageId(input.guildId, reserved, posting))) {
    await compareAndSetOverviewMessageId(input.guildId, reserved, input.messageId);
    return { posted: false, messageId: null };
  }

  try {
    const body = await buildOverviewRequest(input);
    const messageId = await sendOverviewRequest(input, body);
    if (messageId === null) throw new Error('Club overview post returned no message ID');
    if (!(await compareAndSetOverviewMessageId(input.guildId, posting, messageId))) {
      logger.warn('Club overview message could not replace its claim', {
        guildId: input.guildId,
        messageId,
      });
    }
    return { posted: true, messageId };
  } catch (error: unknown) {
    if (isDefinitiveDiscordRejection(error)) {
      await compareAndSetOverviewMessageId(input.guildId, posting, input.messageId);
    } else {
      logger.warn('Club overview outcome is uncertain; manual reconciliation may be needed', {
        guildId: input.guildId,
        error: safeError(error, input.token),
      });
    }
    logger.error('Failed to post club overview', {
      guildId: input.guildId,
      channelId: input.channelId,
      error: safeError(error, input.token),
    });
    return { posted: false, messageId: null };
  }
}

/** Discord guild presentation details used by the auto-posted overview. */
export interface GuildOverviewContext {
  readonly label: string | null;
  readonly iconUrl: string | null;
}

/** Accept a legacy label-only caller or the fuller context used by the schedule. */
export type GuildOverviewInput = string | GuildOverviewContext;

function normalizeContext(input: GuildOverviewInput): GuildOverviewContext {
  return typeof input === 'string' ? { label: input, iconUrl: null } : input;
}

/** Post (or edit) the overview immediately; used when a channel is first configured. */
export async function refreshOverviewNow(
  guildId: string,
  context: GuildOverviewInput,
): Promise<{ readonly posted: boolean; readonly messageId: string | null }> {
  const token = getBotConfig().token;
  if (token === undefined) return { posted: false, messageId: null };

  const settings = await loadGuildSettings(guildId);
  if (settings.overviewChannelId === null) return { posted: false, messageId: null };

  const resolved = normalizeContext(context);
  const rest = new REST({ version: '10' }).setToken(token);
  const claimSentinel = isOverviewClaimSentinel(settings.overviewMessageId);
  const storedClaim = parseOverviewClaim(settings.overviewMessageId);
  return postOverviewWithClaim({
    rest,
    guildId,
    channelId: settings.overviewChannelId,
    messageId: claimSentinel
      ? storedClaim?.stage === 'reserved'
        ? storedClaim.previousMessageId
        : null
      : settings.overviewMessageId,
    claimMessageId: claimSentinel ? settings.overviewMessageId : null,
    guildLabel: resolved.label,
    guildIconUrl: resolved.iconUrl,
    fields: settings.overviewFields,
    token,
  });
}

export type GuildOverviewContextResolver = (guildId: string) => Promise<GuildOverviewContext>;

/** Refresh the overview in every opted-in guild. Safe to call on a timer. */
export async function runClubOverviewPost(
  resolveContext: GuildOverviewContextResolver,
): Promise<void> {
  const token = getBotConfig().token;
  if (token === undefined) {
    logger.warn('Club overview skipped: DISCORD_TOKEN is not configured');
    return;
  }

  let targets: OverviewTarget[];
  try {
    targets = await readOverviewTargets();
  } catch (error) {
    logger.error('Club overview could not read guild targets', { error: safeError(error, token) });
    return;
  }
  if (targets.length === 0) return;

  const rest = new REST({ version: '10' }).setToken(token);
  for (const target of targets) {
    try {
      const context = await resolveContext(target.guildId);
      const result = await postOverviewWithClaim({
        rest,
        guildId: target.guildId,
        channelId: target.channelId,
        messageId: target.messageId,
        claimMessageId: target.claimMessageId,
        guildLabel: context.label,
        guildIconUrl: context.iconUrl,
        fields: target.fields,
        token,
      });
      logger.info('Club overview refreshed', {
        guildId: target.guildId,
        posted: result.posted,
        messageId: result.messageId ?? target.messageId,
      });
    } catch (error) {
      logger.error('Club overview refresh failed for guild', {
        guildId: target.guildId,
        error: safeError(error, token),
      });
    }
  }
}

/** Read the refresh cadence in minutes, defaulting to 30 and clamping to 1..1440. */
function readOverviewIntervalMinutes(): number {
  const raw = process.env.OVERVIEW_INTERVAL_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(1440, Math.max(1, Math.floor(parsed)));
}

/** Start the in-process overview schedule; returns a stop function for shutdown. */
export function startClubOverviewSchedule(
  resolveContext: GuildOverviewContextResolver,
): () => void {
  const intervalMs = readOverviewIntervalMinutes() * 60_000;
  const initialTimer = setTimeout(() => {
    void runClubOverviewPost(resolveContext);
  }, OVERVIEW_INITIAL_DELAY_MS);
  const intervalTimer = setInterval(() => {
    void runClubOverviewPost(resolveContext);
  }, intervalMs);

  logger.info('Club overview schedule enabled', {
    intervalMinutes: intervalMs / 60_000,
    initialDelayMs: OVERVIEW_INITIAL_DELAY_MS,
  });

  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  };
}
