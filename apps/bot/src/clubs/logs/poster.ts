import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../../config';
import { isDefinitiveDiscordRejection } from '../../discord/errors';
import { cleanTag } from '../../discord/format';
import type { ClubLogPeriod } from '../types';
import {
  currentClubLogDigestBoundary,
  dueClubLogDigests,
  type ClubLogDigestBoundary,
} from './digest';
import { buildClubLogDigestImage, buildClubLogEventImage } from './image';
import { loadClubLogView } from './page-view';
import {
  advanceClubLogDigestClaim,
  claimClubLogDigestWindows,
  loadClubLogs,
  loadPostedClubLogDigestPosts,
  loadUndeliveredClubLogEvents,
  markClubLogDigestClaimDelivered,
  markClubLogDigestPosted,
  markClubLogEventsDelivered,
  readClubLogGuildIds,
  readPostedClubLogDigests,
  rekeyClubLogDigestPost,
  releaseClubLogDigestClaims,
  type ClubLogDigestClaimInput,
  type ClubLogDigestPost,
} from './service';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const INITIAL_DELAY_MS = 20_000;
const DEFAULT_EVENT_INTERVAL_MINUTES = 5;
const DIGEST_POLL_MS = 60_000;
/** Bounded fan-out for independent per-log Discord posts and image renders. */
const POST_CONCURRENCY = 4;

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

/** Run independent per-log work with a cap so one slow Discord call does not serialize every club. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        firstError = error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
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
      await mapWithConcurrency(groups, POST_CONCURRENCY, async ({ log, events }) => {
        if (events.length === 0) return;
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
      });
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
  live = false,
): string {
  const label = DIGEST_LABELS[boundary.period];
  const mode = live ? ' / current UTC day' : '';
  return `${safeText(clubName, 60)} • Club Log / Trophy Progression / ${label}${mode} — ${boundary.label} (UTC)`;
}

/**
 * Edit the daily trophy digest in place as a live current-UTC-day view after a
 * sync. The original completed-day ledger row is advanced to the current day so
 * the same Discord message keeps being edited. The completed window is still
 * posted independently by the digest poll, preserving daily archive history.
 * Weekly and season digests are never touched.
 */
export async function refreshTodayClubLogDigest(
  guildId: string,
  now: Date = new Date(),
): Promise<void> {
  const config = getBotConfig();
  const token = config.token;
  if (token === undefined) return;

  const completedBoundary = dueClubLogDigests(now, {
    seasonStartIso: config.seasonStartIso,
    seasonEndIso: config.seasonEndIso,
  }).find((candidate) => candidate.period === 'today');
  if (completedBoundary === undefined) return;
  const liveBoundary = currentClubLogDigestBoundary(now);

  let posts: ClubLogDigestPost[];
  let logs: Awaited<ReturnType<typeof loadClubLogs>>;
  try {
    if (liveBoundary.periodKey === completedBoundary.periodKey) {
      [posts, logs] = await Promise.all([
        loadPostedClubLogDigestPosts(guildId, 'today', liveBoundary.periodKey),
        loadClubLogs(guildId),
      ]);
    } else {
      const [livePosts, completedPosts, loadedLogs] = await Promise.all([
        loadPostedClubLogDigestPosts(guildId, 'today', liveBoundary.periodKey),
        loadPostedClubLogDigestPosts(guildId, 'today', completedBoundary.periodKey),
        loadClubLogs(guildId),
      ]);
      const byLog = new Map<string, ClubLogDigestPost>();
      for (const post of completedPosts) byLog.set(post.logId, post);
      for (const post of livePosts) byLog.set(post.logId, post);
      posts = [...byLog.values()];
      logs = loadedLogs;
    }
  } catch (error) {
    logger.warn('Daily club log digests could not be loaded for refresh', {
      guildId,
      error: safeError(error, token),
    });
    return;
  }
  if (posts.length === 0) return;

  const rest = new REST({ version: '10' }).setToken(token);
  const logsById = new Map(logs.map((log) => [log.id, log]));
  await mapWithConcurrency(posts, POST_CONCURRENCY, async (sourcePost) => {
    let post = sourcePost;
    const log = logsById.get(post.logId);
    if (log === undefined || !log.periods.includes('today')) return;
    const details = {
      guildId,
      logId: log.id,
      periodKey: liveBoundary.periodKey,
      sourcePeriodKey: post.periodKey,
    };
    try {
      const page = await loadClubLogView({
        guildId,
        tag: log.clubTag,
        period: 'today',
        // This is an explicit live current-day view, not a completed window.
        now: liveBoundary.windowEnd,
        asOf: liveBoundary.windowEnd,
      });
      if (page.kind !== 'ok') throw new Error('Club lookup failed');
      const image = await buildClubLogDigestImage(page.value, DIGEST_LABELS.today, 'live');
      if (
        post.periodKey !== liveBoundary.periodKey &&
        !(await rekeyClubLogDigestPost(guildId, post, liveBoundary.periodKey))
      ) {
        logger.warn('Daily club log digest ledger key is occupied; message left unchanged', details);
        return;
      }
      post = { ...post, periodKey: liveBoundary.periodKey };
      const name = filename(log.clubTag, `today-${liveBoundary.periodKey}-live`);
      await rest.patch(Routes.channelMessage(post.channelId, post.messageId), {
        body: {
          content: digestContent(log.clubName, liveBoundary, true),
          allowed_mentions: { parse: [] },
          attachments: [{ id: '0', filename: name }],
        },
        files: [{ key: 'files[0]', name, data: image, contentType: 'image/png' }],
      });
      logger.info('Daily club log digest refreshed as a live view', details);
    } catch (error) {
      logger.warn('Daily club log digest could not be refreshed', {
        ...details,
        error: safeError(error, token),
      });
    }
  });
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
          // A refreshed live message keeps the current-day key, so the
          // completed window remains due and receives its own archived post.
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
        const details = {
          guildId,
          logId: log.id,
          period: boundary.period,
          periodKey: boundary.periodKey,
          channelId: log.channelId,
        };
        let reachedSending = false;
        try {
          // Stage every step before the Discord call: only a pre-send failure
          // may release its claim for another poll to retry.
          if (!(await advanceClubLogDigestClaim(guildId, claim.claimId, key, 'reserved', 'loading'))) {
            failedKeys.push(key);
            logger.warn('Club trophy digest claim is no longer reserved; window stays retryable', details);
            continue;
          }
          const page = await loadClubLogView({
            guildId,
            tag: log.clubTag,
            period: boundary.period,
            now: boundary.windowEnd,
            // A completed window must read the roster and ending trophies that
            // existed at its boundary, not a later snapshot captured since then.
            asOf: boundary.windowEnd,
            ...(boundary.period === 'season'
              ? { seasonStartIso: boundary.windowStart.toISOString() }
              : {}),
          });
          if (page.kind !== 'ok') throw new Error('Club lookup failed');
          const image = await buildClubLogDigestImage(page.value, DIGEST_LABELS[boundary.period]);
          if (!(await advanceClubLogDigestClaim(guildId, claim.claimId, key, 'loading', 'sending'))) {
            failedKeys.push(key);
            logger.warn('Club trophy digest claim could not reach sending; window stays retryable', details);
            continue;
          }
          reachedSending = true;
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
          if (reachedSending && !isDefinitiveDiscordRejection(error)) {
            // Discord may have accepted the message, so the claim is kept for
            // manual reconciliation instead of being released for a repost.
            logger.warn('Club trophy digest outcome is uncertain; manual reconciliation may be needed', {
              ...details,
              error: safeError(error, token),
            });
            continue;
          }
          failedKeys.push(key);
          logger.warn('Club trophy digest post failed; claim is released for retry', {
            ...details,
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
          // The messages are already live: persist their IDs in the sentinel so
          // reconciliation can turn them into real ledger rows and never repost.
          try {
            await markClubLogDigestClaimDelivered(guildId, claim.claimId, saved);
          } catch (recoveryError) {
            logger.warn('Club trophy digest message IDs could not be persisted', {
              guildId,
              keys: saved.map((post) => `${post.logId}:${post.period}:${post.periodKey}`),
              error: safeError(recoveryError, token),
            });
          }
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
