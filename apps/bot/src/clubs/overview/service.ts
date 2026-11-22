import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { loadGuildSettings, setGuildOverviewMessageId } from '../../admin/service';
import { getBotConfig } from '../../config';
import { loadClubSummaries } from '../service';
import { buildClubOverviewEmbeds, buildClubOverviewSelect } from './embed';
import { normalizeOverviewFields } from './fields';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const OVERVIEW_INITIAL_DELAY_MS = 15_000;

export interface OverviewTarget {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string | null;
  readonly fields: readonly string[];
}

/** Read every guild that has opted in to the auto-updating overview. */
export async function readOverviewTargets(): Promise<OverviewTarget[]> {
  const db = createTrustedClient();
  const result = await db
    .from('guild_settings')
    .select('guild_id, overview_channel_id, overview_message_id, overview_fields')
    .not('overview_channel_id', 'is', null);
  if (result.error !== null) {
    throw new Error(`Read overview guilds failed: ${result.error.message}`);
  }

  const targets: OverviewTarget[] = [];
  for (const raw of result.data ?? []) {
    const guildId = typeof raw['guild_id'] === 'string' ? raw['guild_id'] : null;
    const channelId = typeof raw['overview_channel_id'] === 'string' ? raw['overview_channel_id'] : null;
    if (guildId === null || channelId === null) continue;
    const messageId = typeof raw['overview_message_id'] === 'string' ? raw['overview_message_id'] : null;
    const fields = normalizeOverviewFields(raw['overview_fields']);
    targets.push({ guildId, channelId, messageId, fields });
  }
  return targets;
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
  readonly guildLabel: string | null;
  readonly guildIconUrl?: string | null;
  readonly fields: readonly string[];
  readonly token: string | undefined;
}

/** Send the overview once (or edit the existing message), returning its message ID. */
export async function postOverviewForGuild(input: PostOverviewInput): Promise<string | null> {
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
  const body = {
    embeds: embeds.map((embed) => embed.toJSON()),
    components: select === null ? [] : [select],
    allowed_mentions: { parse: [] },
    flags: 0,
  };

  if (input.messageId !== null) {
    try {
      const message = (await input.rest.patch(Routes.channelMessage(input.channelId, input.messageId), {
        body,
      })) as { id?: string } | undefined;
      return message?.id ?? input.messageId;
    } catch (error: unknown) {
      if (!isUnknownMessage(error)) {
        logger.warn('Could not edit club overview message; posting a new one', {
          guildId: input.guildId,
          error: safeError(error, input.token),
        });
      }
      // Unknown/deleted message (or a transient edit failure): post a replacement.
    }
  }

  try {
    const message = (await input.rest.post(Routes.channelMessages(input.channelId), {
      body,
    })) as { id?: string } | undefined;
    const messageId = message?.id ?? null;
    if (messageId === null) {
      logger.warn('Club overview post returned no message ID', { guildId: input.guildId });
    }
    return messageId;
  } catch (error: unknown) {
    logger.error('Failed to post club overview', {
      guildId: input.guildId,
      channelId: input.channelId,
      error: safeError(error, input.token),
    });
    return null;
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
  const messageId = await postOverviewForGuild({
    rest,
    guildId,
    channelId: settings.overviewChannelId,
    messageId: settings.overviewMessageId,
    guildLabel: resolved.label,
    guildIconUrl: resolved.iconUrl,
    fields: settings.overviewFields,
    token,
  });
  if (messageId !== null && messageId !== settings.overviewMessageId) {
    await setGuildOverviewMessageId(guildId, messageId);
  }
  return { posted: messageId !== null, messageId };
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
      const messageId = await postOverviewForGuild({
        rest,
        guildId: target.guildId,
        channelId: target.channelId,
        messageId: target.messageId,
        guildLabel: context.label,
        guildIconUrl: context.iconUrl,
        fields: target.fields,
        token,
      });
      if (messageId !== null && messageId !== target.messageId) {
        await setGuildOverviewMessageId(target.guildId, messageId);
      }
      logger.info('Club overview refreshed', {
        guildId: target.guildId,
        messageId: messageId ?? target.messageId,
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
