import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../../config';
import { buildClubLogEventEmbed } from './embed';
import {
  loadUndeliveredClubLogEvents,
  markClubLogEventsDelivered,
  readClubLogGuildIds,
} from './service';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const INITIAL_DELAY_MS = 20_000;
const DEFAULT_INTERVAL_MINUTES = 5;

function safeError(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(token) ? message.split(token).join(REDACTED) : message;
}

/** Post at most one embed per log per poll; failures stay undelivered for retry. */
export async function runClubLogsPost(): Promise<void> {
  const token = getBotConfig().token;
  if (token === undefined) return;

  let guildIds: string[];
  try {
    guildIds = await readClubLogGuildIds();
  } catch (error) {
    logger.error('Club logs could not read guild targets', { error: safeError(error, token) });
    return;
  }
  if (guildIds.length === 0) return;

  const rest = new REST({ version: '10' }).setToken(token);
  const now = new Date();

  for (const guildId of guildIds) {
    try {
      const groups = await loadUndeliveredClubLogEvents(guildId);
      for (const { log, events } of groups) {
        if (events.length === 0) continue;
        try {
          const embed = buildClubLogEventEmbed({ log, events, now });
          await rest.post(Routes.channelMessages(log.channelId), {
            body: {
              embeds: [embed.toJSON()],
              allowed_mentions: { parse: [] },
            },
          });
          await markClubLogEventsDelivered(
            guildId,
            events.map((event) => ({ logId: log.id, kind: event.kind, eventId: event.id })),
          );
        } catch (error) {
          logger.warn('Club log post failed; leaving events undelivered for retry', {
            guildId,
            logId: log.id,
            channelId: log.channelId,
            error: safeError(error, token),
          });
        }
      }
    } catch (error) {
      logger.warn('Club log events could not be loaded for guild', {
        guildId,
        error: safeError(error, token),
      });
    }
  }
}

/** Read the poll cadence in minutes, clamped to 1..1440 and defaulting to 5. */
function readIntervalMinutes(): number {
  const raw = process.env.CLUB_LOGS_INTERVAL_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(1440, Math.max(1, Math.floor(parsed)));
}

/** Start the in-process club log schedule; returns a stop function for shutdown. */
export function startClubLogsSchedule(): () => void {
  const intervalMs = readIntervalMinutes() * 60_000;
  const initialTimer = setTimeout(() => {
    void runClubLogsPost();
  }, INITIAL_DELAY_MS);
  const intervalTimer = setInterval(() => {
    void runClubLogsPost();
  }, intervalMs);

  logger.info('Club logs schedule enabled', {
    intervalMinutes: intervalMs / 60_000,
    initialDelayMs: INITIAL_DELAY_MS,
  });

  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  };
}
