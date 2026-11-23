import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../../config';
import { cleanTag } from '../../discord/format';
import { buildClubLogPageImage } from './image';
import { CLUB_LOG_PERIOD_LABELS, loadClubLogView } from './page-view';
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

function safeText(value: string, maximum: number): string {
  const sanitized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<[@#&](?:!?\d+|everyone|here)>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = sanitized === '' ? 'Club' : sanitized;
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

/** Post one full-page image per subscribed period when new events exist; failures stay undelivered for retry. */
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

  for (const guildId of guildIds) {
    try {
      const groups = await loadUndeliveredClubLogEvents(guildId);
      for (const { log, events } of groups) {
        if (events.length === 0) continue;
        const period = log.periods[0] ?? 'today';
        try {
          const periodLabel = CLUB_LOG_PERIOD_LABELS[period];
          const page = await loadClubLogView({ guildId, tag: log.clubTag, period });
          if (page.kind !== 'ok') {
            throw new Error('Club lookup failed');
          }
          const image = await buildClubLogPageImage(page.value, events);
          const filename = `club-log-${cleanTag(log.clubTag).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'club'}-${period}-${Date.now()}.png`;
          await rest.post(Routes.channelMessages(log.channelId), {
            body: {
              content: `${safeText(log.clubName, 60)} • Club Logs / Trophy Progression / ${periodLabel}`,
              allowed_mentions: { parse: [] },
              attachments: [{ id: '0', filename }],
            },
            files: [{ key: 'files[0]', name: filename, data: image, contentType: 'image/png' }],
          });
          await markClubLogEventsDelivered(
            guildId,
            events.map((event) => ({
              logId: log.id,
              period,
              kind: event.kind,
              eventId: event.id,
            })),
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
