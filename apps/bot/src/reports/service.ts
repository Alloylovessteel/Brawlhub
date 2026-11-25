import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../config';
import { buildReportImage, describeReportImage, reportImageTitle } from './image';
import { normalizeInactivityDays } from './inactivity';
import {
  latestCompletedReportPeriod,
  previousCompletedReportPeriod,
  REPORT_TYPES,
  reportChannelFor,
  type ReportChannelSettings,
  type ReportPeriod,
  type ReportType,
} from './period';
import type { MutableClubSummary, ReportClubSummary } from './types';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const LEDGER_WRITE_ATTEMPTS = 2;
/** Uncertain periods already warned about; the scheduler retries every tick. */
const warnedUncertainReports = new Set<string>();
const REPORT_CLAIM_PREFIX = 'claim:';
const REPORT_DELIVERED_PREFIX = 'claim-delivered:';
type ReportClaimStage = 'reserved' | 'loading' | 'sending';
/** Explicit retention window for catching up periods missed during an outage. */
const MAX_CATCHUP_PERIODS: Readonly<Record<ReportType, number>> = {
  daily: 31,
  weekly: 8,
  monthly: 12,
};

export interface ReportData {
  readonly period: ReportPeriod;
  readonly clubSummaries: readonly ReportClubSummary[];
  readonly totals: {
    clubs: number;
    joins: number;
    leaves: number;
    transfers: number;
    roleChanges: number;
    capacityOpens: number;
    capacityCloses: number;
  };
}

export interface PostScheduledReportInput {
  readonly rest: REST;
  readonly guildId: string;
  readonly period: ReportPeriod;
  readonly channelId: string;
  readonly token: string | undefined;
  readonly guildLabel: string | null;
}

export interface PostScheduledReportResult {
  readonly posted: boolean;
  readonly messageId: string | null;
  /** False when Discord accepted the message but the ledger write failed. */
  readonly recorded?: boolean;
  /** This caller won the fresh sentinel for the period. */
  readonly claimed?: boolean;
  /** Another caller owns the period; no Discord call was made. */
  readonly skipped?: boolean;
  /** A prior worker may have sent a message whose ID was never persisted. */
  readonly uncertain?: boolean;
  readonly error?: string;
}

export interface ScheduledReportRunResult {
  /** Report types with at least one failed guild post; safe to retry this period. */
  readonly failedTypes: readonly ReportType[];
  /** Types where every guild already had an in-progress claim. */
  readonly skippedTypes: readonly ReportType[];
  /** Types where this run acquired fresh claims. */
  readonly claimedTypes: readonly ReportType[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function requireOk(error: unknown, action: string): void {
  if (error === null || error === undefined) return;
  const candidate = asRecord(error);
  const message = candidate?.['message'];
  throw new Error(`${action} failed: ${typeof message === 'string' ? message : String(error)}`);
}

function safeError(error: unknown, token: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  return token !== undefined && token.length > 0 && message.includes(token)
    ? message.split(token).join(REDACTED)
    : message;
}

function isUnknownMessage(error: unknown): boolean {
  const candidate = asRecord(error);
  if (candidate === null) return false;
  const code = candidate['code'];
  const status = candidate['status'];
  return (
    code === 10008 ||
    code === '10008' ||
    status === 404 ||
    status === '404' ||
    candidate['message'] === 'Unknown Message'
  );
}

interface ParsedReportClaim {
  readonly claimId: string;
  readonly stage: ReportClaimStage | 'legacy';
}

function reportClaimMessageId(claimId: string, stage: ReportClaimStage = 'reserved'): string {
  return `${REPORT_CLAIM_PREFIX}${claimId}:${stage}`;
}

function reportDeliveredClaimMessageId(claimId: string, messageId: string): string {
  return `${REPORT_DELIVERED_PREFIX}${claimId}:${messageId}`;
}

function parseReportClaim(messageId: string | null): ParsedReportClaim | null {
  if (messageId === null || !messageId.startsWith(REPORT_CLAIM_PREFIX)) return null;
  const parts = messageId.slice(REPORT_CLAIM_PREFIX.length).split(':');
  const claimId = parts[0];
  if (claimId === undefined || claimId === '') return null;
  const stage = parts[1];
  if (stage === 'reserved' || stage === 'loading' || stage === 'sending') {
    return { claimId, stage };
  }
  // Older claims carried no stage, so a send can never be ruled out.
  return parts.length === 1 ? { claimId, stage: 'legacy' } : null;
}

function isRecoverableReportClaim(claim: ParsedReportClaim): boolean {
  return claim.stage === 'reserved' || claim.stage === 'loading';
}

/**
 * A delivered sentinel carries the Discord message ID, so it is durable even
 * before reconciliation. Only a claim whose stage is provably pre-send can be
 * safely reclaimed; sending and legacy claims are uncertain.
 */
function isDeliveredReportMessage(messageId: string | null): boolean {
  if (messageId === null) return false;
  if (messageId.startsWith(REPORT_DELIVERED_PREFIX)) {
    return parseReportDeliveredClaim(messageId) !== null;
  }
  return !messageId.startsWith(REPORT_CLAIM_PREFIX);
}

function parseReportDeliveredClaim(messageId: string): string | null {
  if (!messageId.startsWith(REPORT_DELIVERED_PREFIX)) return null;
  const separator = messageId.indexOf(':', REPORT_DELIVERED_PREFIX.length);
  const recoveredId = separator === -1 ? null : messageId.slice(separator + 1);
  return recoveredId === null || recoveredId === '' ? null : recoveredId;
}

function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

/**
 * Load one guild's activity from stored sync history. Both the club list and
 * the event aggregation are database RPCs so REST row caps cannot omit clubs
 * or undercount a busy period.
 */
export async function loadReportData(guildId: string, period: ReportPeriod): Promise<ReportData> {
  const db = createTrustedClient();
  const [clubsResult, activityResult] = await Promise.all([
    db.rpc('push_report_clubs', { p_guild_id: guildId }),
    db.rpc('push_report_activity', {
      p_guild_id: guildId,
      p_start: period.start.toISOString(),
      p_end: period.end.toISOString(),
    }),
  ]);
  requireOk(clubsResult.error, 'Read report clubs');
  requireOk(activityResult.error, 'Aggregate report activity');

  const summaries: MutableClubSummary[] = [];
  const byClub = new Map<string, MutableClubSummary>();
  for (const raw of Array.isArray(clubsResult.data) ? clubsResult.data : []) {
    const row = asRecord(raw);
    const clubId = asString(row?.['id']);
    if (row === null || clubId === null) continue;
    const summary: MutableClubSummary = {
      clubId,
      tag: asString(row['tag']) ?? '',
      name: asString(row['name']) ?? '',
      joins: 0,
      leaves: 0,
      transfers: 0,
      roleChanges: 0,
      capacityOpens: 0,
      capacityCloses: 0,
    };
    summaries.push(summary);
    byClub.set(clubId, summary);
  }

  let totals: ReportData['totals'] = {
    clubs: summaries.length,
    joins: 0,
    leaves: 0,
    transfers: 0,
    roleChanges: 0,
    capacityOpens: 0,
    capacityCloses: 0,
  };
  for (const raw of Array.isArray(activityResult.data) ? activityResult.data : []) {
    const row = asRecord(raw);
    if (row === null) continue;
    const clubId = asString(row['club_id']);
    const values = {
      joins: asCount(row['joins']),
      leaves: asCount(row['leaves']),
      transfers: asCount(row['transfers']),
      roleChanges: asCount(row['role_changes']),
      capacityOpens: asCount(row['capacity_opens']),
      capacityCloses: asCount(row['capacity_closes']),
    };
    if (clubId === null) {
      totals = { clubs: summaries.length, ...values };
      continue;
    }
    const summary = byClub.get(clubId);
    if (summary === undefined) continue;
    Object.assign(summary, values);
  }

  return { period, clubSummaries: summaries, totals };
}

/** Post a scheduled report once per guild/type/period, editing replays in place. */
export async function postScheduledReport(
  input: PostScheduledReportInput,
): Promise<PostScheduledReportResult> {
  const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
  if (channelId === '') {
    return { posted: false, messageId: null, error: 'No report channel configured' };
  }

  const db = createTrustedClient();
  const claimId = randomUUID();
  let claimMessageId = reportClaimMessageId(claimId, 'reserved');
  const ledgerOptions = { onConflict: 'guild_id,report_type,period_key' } as const;
  let ownsClaim = false;
  let existingMessageId: string | null = null;
  /** Ledger value we are replacing; used to keep a recovered ID on write failure. */
  let expectedPriorValue: string | null = null;

  const releaseClaim = async (): Promise<void> => {
    if (!ownsClaim) return;
    try {
      await db
        .from('guild_report_posts')
        .delete()
        .eq('guild_id', input.guildId)
        .eq('report_type', input.period.type)
        .eq('period_key', input.period.periodKey)
        .eq('message_id', claimMessageId);
    } catch {
      // Keep the original failure as the result; the next tick can retry.
    }
  };

  const transitionClaim = async (stage: ReportClaimStage): Promise<boolean> => {
    if (!ownsClaim) return false;
    const nextId = reportClaimMessageId(claimId, stage);
    const updated = await db
      .from('guild_report_posts')
      .update({ message_id: nextId })
      .eq('guild_id', input.guildId)
      .eq('report_type', input.period.type)
      .eq('period_key', input.period.periodKey)
      .eq('message_id', claimMessageId)
      .select('message_id');
    requireOk(updated.error, `Advance report claim to ${stage}`);
    const won = (updated.data ?? []).some(
      (item) => asString(asRecord(item)?.['message_id']) === nextId,
    );
    if (won) claimMessageId = nextId;
    return won;
  };

  const readCurrentMessageId = async (): Promise<string | null> => {
    const current = await db
      .from('guild_report_posts')
      .select('message_id')
      .eq('guild_id', input.guildId)
      .eq('report_type', input.period.type)
      .eq('period_key', input.period.periodKey)
      .maybeSingle();
    requireOk(current.error, 'Read report post');
    return asString(asRecord(current.data)?.['message_id']);
  };

  // Reserve before any data load or Discord call so two workers cannot both
  // conclude they own the period. The staged sentinel tells a later worker
  // whether a claim is provably pre-send or possibly already delivered.
  try {
    const reserved = await db
      .from('guild_report_posts')
      .upsert(
        {
          guild_id: input.guildId,
          report_type: input.period.type,
          period_key: input.period.periodKey,
          channel_id: channelId,
          message_id: claimMessageId,
        },
        { ...ledgerOptions, ignoreDuplicates: true },
      )
      .select('message_id');
    requireOk(reserved.error, 'Reserve report post');
    ownsClaim = (reserved.data ?? []).some(
      (item) => asString(asRecord(item)?.['message_id']) === claimMessageId,
    );

    if (!ownsClaim) {
      const currentMessageId = await readCurrentMessageId();
      if (currentMessageId === null) return { posted: false, messageId: null, skipped: true };

      const deliveredId = parseReportDeliveredClaim(currentMessageId);
      if (deliveredId !== null) {
        existingMessageId = deliveredId;
        expectedPriorValue = currentMessageId;
      } else {
        const claim = parseReportClaim(currentMessageId);
        if (claim !== null && isRecoverableReportClaim(claim)) {
          const takeoverId = reportClaimMessageId(claimId, 'reserved');
          const taken = await db
            .from('guild_report_posts')
            .update({ message_id: takeoverId })
            .eq('guild_id', input.guildId)
            .eq('report_type', input.period.type)
            .eq('period_key', input.period.periodKey)
            .eq('message_id', currentMessageId)
            .select('message_id');
          requireOk(taken.error, 'Recover report claim');
          ownsClaim = (taken.data ?? []).some(
            (item) => asString(asRecord(item)?.['message_id']) === takeoverId,
          );
          if (ownsClaim) {
            claimMessageId = takeoverId;
            expectedPriorValue = currentMessageId;
          } else {
            const newest = await readCurrentMessageId();
            if (newest === null) return { posted: false, messageId: null, skipped: true };
            const recovered = parseReportDeliveredClaim(newest);
            if (recovered !== null) {
              existingMessageId = recovered;
              expectedPriorValue = newest;
            } else {
              logger.debug('Skipping uncertain report claim', {
                guildId: input.guildId,
                reportType: input.period.type,
                periodKey: input.period.periodKey,
              });
              return { posted: false, messageId: null, skipped: true, uncertain: true };
            }
          }
        } else if (claim === null) {
          existingMessageId = currentMessageId;
          expectedPriorValue = currentMessageId;
        } else {
          logger.debug('Skipping uncertain report claim', {
            guildId: input.guildId,
            reportType: input.period.type,
            periodKey: input.period.periodKey,
          });
          return { posted: false, messageId: null, skipped: true, uncertain: true };
        }
      }
    }
  } catch (error: unknown) {
    return { posted: false, messageId: null, error: safeError(error, input.token) };
  }

  // A worker that only recovered a delivered message edits it in place and does
  // not need to own a staged claim. Only a fresh/taken-over pre-send claim is
  // advanced through the stages.
  if (ownsClaim && !(await transitionClaim('loading'))) {
    return { posted: false, messageId: null, skipped: true };
  }

  let data: ReportData;
  let image: Buffer;
  try {
    data = await loadReportData(input.guildId, input.period);
    image = await buildReportImage(data, input.guildLabel ?? input.guildId);
  } catch (error: unknown) {
    await releaseClaim();
    return { posted: false, messageId: null, error: safeError(error, input.token) };
  }

  if (ownsClaim && !(await transitionClaim('sending'))) {
    return { posted: false, messageId: null, skipped: true };
  }

  const name = `club-report-${input.period.type}-${input.period.periodKey}.png`;
  const body = {
    content: reportImageTitle(input.period),
    embeds: [],
    attachments: [{ id: '0', filename: name, description: describeReportImage(data) }],
    allowed_mentions: { parse: [] },
    flags: 0,
  };
  const files = [{ key: 'files[0]', name, data: image, contentType: 'image/png' }];

  let messageId: string | null = null;
  if (existingMessageId !== null) {
    try {
      const message = (await input.rest.patch(
        Routes.channelMessage(channelId, existingMessageId),
        { body, files },
      )) as { id?: string } | undefined;
      messageId = asString(message?.id) ?? existingMessageId;
    } catch (error: unknown) {
      if (!isUnknownMessage(error)) {
        await releaseClaim();
        return { posted: false, messageId: null, error: safeError(error, input.token) };
      }
    }
  }

  if (messageId === null) {
    try {
      const message = (await input.rest.post(Routes.channelMessages(channelId), {
        body,
        files,
      })) as { id?: string } | undefined;
      messageId = asString(message?.id);
    } catch (error: unknown) {
      // The claim is already marked `sending`; a timeout may still have sent.
      logger.warn('Report send outcome is uncertain', {
        guildId: input.guildId,
        reportType: input.period.type,
        periodKey: input.period.periodKey,
        error: safeError(error, input.token),
      });
      return {
        posted: false,
        messageId: null,
        uncertain: true,
        error: safeError(error, input.token),
      };
    }
    if (messageId === null) {
      return {
        posted: false,
        messageId: null,
        uncertain: true,
        error: 'Discord report post returned no message ID',
      };
    }
  }

  const ledgerPayload = {
    guild_id: input.guildId,
    report_type: input.period.type,
    period_key: input.period.periodKey,
    channel_id: channelId,
    message_id: messageId,
  };
  let recordError: string | null = null;
  for (let attempt = 0; attempt < LEDGER_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const { error } = await db.from('guild_report_posts').upsert(ledgerPayload, ledgerOptions);
      if (!error) {
        recordError = null;
        break;
      }
      recordError = error.message;
    } catch (error: unknown) {
      recordError = safeError(error, input.token);
    }
  }
  if (recordError !== null) {
    // Discord already has the message. Keep its ID where the next claim can
    // find it so a retry edits that message instead of posting another one.
    if (expectedPriorValue !== null) {
      try {
        const current = await db
          .from('guild_report_posts')
          .select('message_id')
          .eq('guild_id', input.guildId)
          .eq('report_type', input.period.type)
          .eq('period_key', input.period.periodKey)
          .maybeSingle();
        if (asString(asRecord(current.data)?.['message_id']) === expectedPriorValue) {
          await db.from('guild_report_posts').upsert(
            { ...ledgerPayload, message_id: reportDeliveredClaimMessageId(claimId, messageId) },
            ledgerOptions,
          );
        }
      } catch {
        // An ID-less claim is uncertain; a later attempt skips instead of posting.
      }
    }
    return { posted: true, messageId, recorded: false, claimed: ownsClaim, error: recordError };
  }

  return { posted: true, messageId, claimed: ownsClaim };
}

export interface MissingReportDeliveryTarget {
  readonly guildId: string;
  readonly period: ReportPeriod;
}

export interface MissingReportDeliveries {
  /** Completed periods in the retention window with at least one missing delivery. */
  readonly periods: readonly ReportPeriod[];
  /** Exact guild/period pairs the scheduler should attempt. */
  readonly targets: readonly MissingReportDeliveryTarget[];
  /** Current UTC inactivity day key when a configured guild is still missing a durable post. */
  readonly inactivityPeriodKey: string | null;
}

/** Enumerate the explicit retention window of completed periods for one type. */
function reportCatchupPeriods(now: Date, type: ReportType): ReportPeriod[] {
  const periods: ReportPeriod[] = [];
  let period = latestCompletedReportPeriod(now, type);
  for (let index = 0; index < MAX_CATCHUP_PERIODS[type]; index += 1) {
    periods.unshift(period);
    period = previousCompletedReportPeriod(period);
  }
  return periods;
}

/**
 * Durable delivery state for the scheduler. Ledger keys are authoritative and
 * scoped per guild, so a restart, a missed UTC boundary, or one failed guild
 * cannot hide another guild's undelivered period. Old gaps inside the explicit
 * retention window are included, not just the latest period.
 */
export async function readMissingReportDeliveries(now: Date): Promise<MissingReportDeliveries> {
  const db = createTrustedClient();
  const inactivityPeriodKey = now.toISOString().slice(0, 10);

  const [settings, posts, inactivity] = await Promise.all([
    db
      .from('guild_settings')
      .select(
        'guild_id, overview_channel_id, report_daily_channel_id, report_weekly_channel_id, report_monthly_channel_id, report_inactivity_days, report_inactivity_channel_id',
      )
      .or(
        'overview_channel_id.not.is.null,report_daily_channel_id.not.is.null,report_weekly_channel_id.not.is.null,report_monthly_channel_id.not.is.null,report_inactivity_channel_id.not.is.null',
      ),
    db.from('guild_report_posts').select('guild_id, report_type, period_key, message_id'),
    db.from('guild_inactivity_report_posts').select('guild_id, period_key, message_id'),
  ]);
  requireOk(settings.error, 'Read report guilds');
  requireOk(posts.error, 'Read report post ledger');
  requireOk(inactivity.error, 'Read inactivity report post ledger');

  const guilds = (settings.data ?? [])
    .map(parseScheduledGuild)
    .filter((guild): guild is ScheduledGuild => guild !== null);
  const posted = new Set<string>();
  for (const item of posts.data ?? []) {
    const row = asRecord(item);
    const guildId = asString(row?.['guild_id']);
    const type = asString(row?.['report_type']);
    const periodKey = asString(row?.['period_key']);
    const messageId = asString(row?.['message_id']);
    if (
      guildId === null || type === null || periodKey === null ||
      !isDeliveredReportMessage(messageId)
    ) {
      continue;
    }
    posted.add(`${guildId}:${type}:${periodKey}`);
  }
  const inactivityPosted = new Set<string>();
  for (const item of inactivity.data ?? []) {
    const row = asRecord(item);
    const guildId = asString(row?.['guild_id']);
    const periodKey = asString(row?.['period_key']);
    const messageId = asString(row?.['message_id']);
    if (
      guildId === null || periodKey !== inactivityPeriodKey ||
      !isDeliveredReportMessage(messageId)
    ) {
      continue;
    }
    inactivityPosted.add(guildId);
  }

  const targets: MissingReportDeliveryTarget[] = [];
  const periods = new Map<string, ReportPeriod>();
  for (const guild of guilds) {
    for (const type of REPORT_TYPES) {
      if (reportChannelFor(guild, type) === null) continue;
      for (const period of reportCatchupPeriods(now, type)) {
        if (posted.has(`${guild.guildId}:${type}:${period.periodKey}`)) continue;
        targets.push({ guildId: guild.guildId, period });
        periods.set(`${type}:${period.periodKey}`, period);
      }
    }
  }
  const inactivityMissing = guilds.some(
    (guild) =>
      guild.inactivityDays !== null &&
      guild.inactivityChannelId !== null &&
      !inactivityPosted.has(guild.guildId),
  );

  return {
    periods: [...periods.values()],
    targets,
    inactivityPeriodKey: inactivityMissing ? inactivityPeriodKey : null,
  };
}

interface ScheduledGuild extends ReportChannelSettings {
  readonly guildId: string;
  readonly inactivityDays: number | null;
  readonly inactivityChannelId: string | null;
}

function parseScheduledGuild(value: unknown): ScheduledGuild | null {
  const row = asRecord(value);
  const guildId = asString(row?.['guild_id']);
  if (row === null || guildId === null) return null;
  return {
    guildId,
    overviewChannelId: asString(row['overview_channel_id']),
    reportDailyChannelId: asString(row['report_daily_channel_id']),
    reportWeeklyChannelId: asString(row['report_weekly_channel_id']),
    reportMonthlyChannelId: asString(row['report_monthly_channel_id']),
    inactivityDays: normalizeInactivityDays(row['report_inactivity_days']),
    inactivityChannelId:
      asString(row['report_inactivity_channel_id']) ?? asString(row['overview_channel_id']),
  };
}

/**
 * Fan out the due report types for every opted-in guild. Daily runs every day,
 * weekly only on Monday's boundary, monthly only on the 1st's boundary; callers
 * pass the specific types that became due at this tick.
 */
export async function runScheduledReports(
  now: Date,
  types: readonly ReportType[] = REPORT_TYPES,
): Promise<ScheduledReportRunResult> {
  const failedTypes = new Set<ReportType>();
  const skippedTypes = new Set<ReportType>();
  const claimedTypes = new Set<ReportType>();
  const token = getBotConfig().token;
  if (token === undefined) {
    logger.warn('Scheduled reports skipped: DISCORD_TOKEN is not configured');
    for (const type of types) failedTypes.add(type);
    return { failedTypes: [...failedTypes], skippedTypes: [], claimedTypes: [] };
  }

  let guilds: ScheduledGuild[];
  try {
    const result = await createTrustedClient()
      .from('guild_settings')
      .select(
        'guild_id, overview_channel_id, report_daily_channel_id, report_weekly_channel_id, report_monthly_channel_id',
      )
      .or(
        'overview_channel_id.not.is.null,report_daily_channel_id.not.is.null,report_weekly_channel_id.not.is.null,report_monthly_channel_id.not.is.null',
      );
    requireOk(result.error, 'Read report guilds');
    guilds = (result.data ?? [])
      .map(parseScheduledGuild)
      .filter((guild): guild is ScheduledGuild => guild !== null);
  } catch (error: unknown) {
    logger.error('Scheduled reports could not read guild targets', {
      error: safeError(error, token),
    });
    for (const type of types) failedTypes.add(type);
    return { failedTypes: [...failedTypes], skippedTypes: [], claimedTypes: [] };
  }

  if (guilds.length === 0) return { failedTypes: [], skippedTypes: [], claimedTypes: [] };
  const rest = new REST({ version: '10' }).setToken(token);
  const guildById = new Map(guilds.map((guild) => [guild.guildId, guild]));

  let missing: MissingReportDeliveries;
  try {
    missing = await readMissingReportDeliveries(now);
  } catch (error: unknown) {
    logger.error('Scheduled report targets could not be read', {
      error: safeError(error, token),
    });
    for (const type of types) failedTypes.add(type);
    return { failedTypes: [...failedTypes], skippedTypes: [], claimedTypes: [] };
  }

  for (const target of missing.targets) {
    const type = target.period.type;
    if (!types.includes(type)) continue;
    const guild = guildById.get(target.guildId);
    if (guild === undefined) continue;
    try {
      const channelId = reportChannelFor(guild, type);
      if (channelId === null) continue;
      const result = await postScheduledReport({
        rest,
        guildId: guild.guildId,
        period: target.period,
        channelId,
        token,
        guildLabel: null,
      });
      if (result.uncertain === true) {
        skippedTypes.add(type);
        const uncertainKey = `${guild.guildId}:${type}:${target.period.periodKey}`;
        if (!warnedUncertainReports.has(uncertainKey)) {
          warnedUncertainReports.add(uncertainKey);
          logger.warn('Scheduled report outcome is uncertain; manual reconciliation may be needed', {
            guildId: guild.guildId,
            reportType: type,
            periodKey: target.period.periodKey,
          });
        }
        continue;
      }
      if (result.skipped === true) {
        skippedTypes.add(type);
        continue;
      }
      if (result.claimed === true) claimedTypes.add(type);
      if (!result.posted || result.recorded === false || result.error !== undefined) {
        failedTypes.add(type);
        logger.warn('Scheduled report was not fully recorded', {
          guildId: guild.guildId,
          reportType: type,
          periodKey: target.period.periodKey,
          messageId: result.messageId,
          error: result.error ?? 'unknown error',
        });
      }
    } catch (error: unknown) {
      failedTypes.add(type);
      logger.warn('Scheduled report failed for guild', {
        guildId: guild.guildId,
        reportType: type,
        periodKey: target.period.periodKey,
        error: safeError(error, token),
      });
    }
  }

  return {
    failedTypes: [...failedTypes],
    skippedTypes: [...skippedTypes],
    claimedTypes: [...claimedTypes],
  };
}
