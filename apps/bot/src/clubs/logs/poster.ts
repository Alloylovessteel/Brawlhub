import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../../config';
import { cleanTag } from '../../discord/format';
import type { ClubLogPeriod } from '../types';
import { dueClubLogDigests, type ClubLogDigestBoundary } from './digest';
import { buildClubLogDigestImage, buildClubLogEventImage } from './image';
import { loadClubLogView } from './page-view';
import {
  claimClubLogDigestWindows,
  loadClubLogs,
  loadUndeliveredClubLogEvents,
  markClubLogDigestPosted,
  markClubLogEventsDelivered,
  readClubLogGuildIds,
  readPostedClubLogDigests,
  releaseClubLogDigestClaims,
  type ClubLogDigestClaimInput,
  type ClubLogDigestPost,
} from './service';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const INITIAL_DELAY_MS = 20_000;
const DEFAULT_EVENT_INTERVAL_MINUTES = 5;
const DIGEST_POLL_MS = 60_000;

const DIGEST_LABELS: Readonly<Record<ClubLogPeriod, string>> = {
  today: 'Daily',
  week: 'Weekly',
  season: 'Season',
};

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

function filename(tag: string, suffix: string): string {
  const slug = cleanTag(tag).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'club';
  return `club-log-${slug}-${suffix}-${Date.now()}.png`;
}

/** Post one changes-only image per subscribed club when new events exist. */
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
        try {
          // Changes post once under the legacy `today` key so old event-ledger
          // rows from 0032 are not republished as a new event log.
          const period: ClubLogPeriod = 'today';
          const image = await buildClubLogEventImage(
            { name: log.clubName, tag: log.clubTag },
            events,
          );
          const name = filename(log.clubTag, 'changes');
          await rest.post(Routes.channelMessages(log.channelId), {
            body: {
              content: `${safeText(log.clubName, 60)} • Club Log / Members & Roles`,
              allowed_mentions: { parse: [] },
              attachments: [{ id: '0', filename: name }],
            },
            files: [{ key: 'files[0]', name, data: image, contentType: 'image/png' }],
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
          logger.warn('Club event log post failed; leaving events undelivered for retry', {
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

function digestKey(logId: string, boundary: ClubLogDigestBoundary): string {
  return `${logId}:${boundary.period}:${boundary.periodKey}`;
}

function digestContent(
  clubName: string,
  boundary: ClubLogDigestBoundary,
): string {
  const label = DIGEST_LABELS[boundary.period];
  return `${safeText(clubName, 60)} • Club Log / Trophy Progression / ${label} — ${boundary.label} (UTC)`;
}

/**
 * Post completed-window trophy digests. Every poll re-derives the same boundary
 * until the ledger records it, so a restart or overlap never reposts a window.
 */
export async function runClubLogDigests(now: Date = new Date()): Promise<void> {
  const token = getBotConfig().token;
  if (token === undefined) return;

  const config = getBotConfig();
  const boundaries = dueClubLogDigests(now, {
    seasonStartIso: config.seasonStartIso,
    seasonEndIso: config.seasonEndIso,
  });
  if (boundaries.length === 0) return;

  let guildIds: string[];
  try {
    guildIds = await readClubLogGuildIds();
  } catch (error) {
    logger.error('Club digests could not read guild targets', { error: safeError(error, token) });
    return;
  }
  if (guildIds.length === 0) return;

  const rest = new REST({ version: '10' }).setToken(token);

  for (const guildId of guildIds) {
    try {
      const [logs, posted] = await Promise.all([
        loadClubLogs(guildId),
        readPostedClubLogDigests(guildId),
      ]);
      const pending = new Map<string, { log: (typeof logs)[number]; boundary: ClubLogDigestBoundary }>();
      for (const log of logs) {
        for (const boundary of boundaries) {
          if (!log.periods.includes(boundary.period)) continue;
          if (posted.has(digestKey(log.id, boundary))) continue;
          pending.set(digestKey(log.id, boundary), { log, boundary });
        }
      }

      if (pending.size === 0) continue;
      const claimInputs: ClubLogDigestClaimInput[] = [...pending.values()].map(
        ({ log, boundary }) => ({
          logId: log.id,
          period: boundary.period,
          periodKey: boundary.periodKey,
          channelId: log.channelId,
        }),
      );
      let claim: Awaited<ReturnType<typeof claimClubLogDigestWindows>>;
      try {
        // Claim before any Discord call so overlapping polls and restarts cannot
        // both render the same completed window.
        claim = await claimClubLogDigestWindows(guildId, claimInputs, { now });
      } catch (error) {
        logger.warn('Club trophy digest claims could not be acquired', {
          guildId,
          error: safeError(error, token),
        });
        continue;
      }
      if (claim.keys.size === 0) continue;

      const saved: ClubLogDigestPost[] = [];
      const failedKeys: string[] = [];
      for (const [key, { log, boundary }] of pending) {
        if (!claim.keys.has(key)) continue;
        try {
          const page = await loadClubLogView({
            guildId,
            tag: log.clubTag,
            period: boundary.period,
            now: boundary.windowEnd,
            ...(boundary.period === 'season'
              ? { seasonStartIso: boundary.windowStart.toISOString() }
              : {}),
          });
          if (page.kind !== 'ok') throw new Error('Club lookup failed');
          const image = await buildClubLogDigestImage(page.value, DIGEST_LABELS[boundary.period]);
          const name = filename(log.clubTag, `${boundary.period}-${boundary.periodKey}`);
          const response = (await rest.post(Routes.channelMessages(log.channelId), {
            body: {
              content: digestContent(log.clubName, boundary),
              allowed_mentions: { parse: [] },
              attachments: [{ id: '0', filename: name }],
            },
            files: [{ key: 'files[0]', name, data: image, contentType: 'image/png' }],
          })) as { id?: string } | undefined;
          const messageId = response?.id;
          if (messageId === undefined || messageId === '') {
            throw new Error('Discord club digest post returned no message ID');
          }
          saved.push({
            logId: log.id,
            period: boundary.period,
            periodKey: boundary.periodKey,
            channelId: log.channelId,
            messageId,
          });
        } catch (error) {
          failedKeys.push(key);
          logger.warn('Club trophy digest post failed; claim is released for retry', {
            guildId,
            logId: log.id,
            period: boundary.period,
            periodKey: boundary.periodKey,
            channelId: log.channelId,
            error: safeError(error, token),
          });
        }
      }
      if (failedKeys.length > 0) {
        try {
          await releaseClubLogDigestClaims(guildId, claim.claimId, failedKeys);
        } catch (error) {
          logger.warn('Club trophy digest claims could not be released', {
            guildId,
            keys: failedKeys,
            error: safeError(error, token),
          });
        }
      }
      if (saved.length > 0) {
        try {
          await markClubLogDigestPosted(guildId, saved);
        } catch (error) {
          // The messages are already live. Keep the claim sentinel so stale
          // recovery is the only path that can revisit this window.
          logger.warn('Club trophy digest ledger write failed; claim kept for recovery', {
            guildId,
            keys: saved.map((post) => `${post.logId}:${post.period}:${post.periodKey}`),
            error: safeError(error, token),
          });
        }
      }
    } catch (error) {
      logger.warn('Club digests could not be processed for guild', {
        guildId,
        error: safeError(error, token),
      });
    }
  }
}

/** Read the event-poll cadence in minutes, clamped to 1..1440, default 5. */
function readEventIntervalMinutes(): number {
  const raw = process.env.CLUB_LOGS_INTERVAL_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_EVENT_INTERVAL_MINUTES;
  return Math.min(1440, Math.max(1, Math.floor(parsed)));
}

/** Start the in-process club log schedule; returns a stop function for shutdown. */
export function startClubLogsSchedule(): () => void {
  const eventIntervalMs = readEventIntervalMinutes() * 60_000;
  let digestRunning = false;
  const pollDigests = (): void => {
    if (digestRunning) return;
    digestRunning = true;
    void runClubLogDigests().finally(() => {
      digestRunning = false;
    });
  };

  const initialTimer = setTimeout(() => {
    void runClubLogsPost();
    pollDigests();
  }, INITIAL_DELAY_MS);
  const eventTimer = setInterval(() => {
    void runClubLogsPost();
  }, eventIntervalMs);
  const digestTimer = setInterval(pollDigests, DIGEST_POLL_MS);

  logger.info('Club logs schedule enabled', {
    eventIntervalMinutes: eventIntervalMs / 60_000,
    digestPollSeconds: DIGEST_POLL_MS / 1000,
    initialDelayMs: INITIAL_DELAY_MS,
  });

  return () => {
    clearTimeout(initialTimer);
    clearInterval(eventTimer);
    clearInterval(digestTimer);
  };
}
