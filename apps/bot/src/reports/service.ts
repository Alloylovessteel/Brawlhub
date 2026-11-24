import { randomUUID } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../config';
import { buildReportEmbed } from './embed';
import { normalizeInactivityDays } from './inactivity';
import {
  latestCompletedReportPeriod,
  REPORT_TYPES,
  reportChannelFor,
  type ReportChannelSettings,
  type ReportPeriod,
  type ReportType,
} from './period';
import type { MutableClubSummary, ReportClubSummary } from './types';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const MAX_REPORT_CLUBS = 25;
const MAX_EVENT_ROWS = 10_000;
const LEDGER_WRITE_ATTEMPTS = 2;
const REPORT_CLAIM_PREFIX = 'claim:';
const REPORT_DELIVERED_PREFIX = 'claim-delivered:';

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

function withinPeriod(value: unknown, startMs: number, endMs: number): boolean {
  const parsed = asString(value);
  if (parsed === null) return false;
  const timestamp = Date.parse(parsed);
  return !Number.isNaN(timestamp) && timestamp >= startMs && timestamp < endMs;
}

function reportClaimMessageId(claimId: string): string {
  return `${REPORT_CLAIM_PREFIX}${claimId}`;
}

function reportDeliveredClaimMessageId(claimId: string, messageId: string): string {
  return `${REPORT_DELIVERED_PREFIX}${claimId}:${messageId}`;
}

function isReportClaim(messageId: string | null): boolean {
  return (
    messageId !== null &&
    (messageId.startsWith(REPORT_CLAIM_PREFIX) || messageId.startsWith(REPORT_DELIVERED_PREFIX))
  );
}

/**
 * A delivered sentinel carries the Discord message ID, so it is durable even
 * before reconciliation. Only an ID-less plain claim means "not delivered".
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

/**
 * Load one guild's activity from stored sync history. Every query is scoped by
 * the guild ID or by club IDs that were themselves read with that guild ID.
 */
export async function loadReportData(guildId: string, period: ReportPeriod): Promise<ReportData> {
  const db = createTrustedClient();
  const clubsResult = await db
    .from('clubs')
    .select('id, tag, name')
    .eq('guild_id', guildId)
    .is('archived_at', null)
    .order('name', { ascending: true })
    .limit(MAX_REPORT_CLUBS);
  requireOk(clubsResult.error, 'Read report clubs');

  const summaries: MutableClubSummary[] = [];
  const byClub = new Map<string, MutableClubSummary>();
  for (const raw of clubsResult.data ?? []) {
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

  const emptyTotals: ReportData['totals'] = {
    clubs: summaries.length,
    joins: 0,
    leaves: 0,
    transfers: 0,
    roleChanges: 0,
    capacityOpens: 0,
    capacityCloses: 0,
  };
  if (summaries.length === 0) {
    return { period, clubSummaries: [], totals: emptyTotals };
  }

  const clubIds = summaries.map((summary) => summary.clubId);
  const startIso = period.start.toISOString();
  const endIso = period.end.toISOString();
  const startMs = period.start.getTime();
  const endMs = period.end.getTime();
  const membershipColumns = 'id, event_type, from_club_id, to_club_id, detected_at';

  // A transfer appears in both queries, so credit each event/club/field once.
  const credited = new Set<string>();
  const transferEventIds = new Set<string>();
  const credit = (eventId: string, clubId: string | null, field: 'joins' | 'leaves' | 'transfers') => {
    if (clubId === null) return;
    const summary = byClub.get(clubId);
    if (summary === undefined) return;
    const key = `${eventId}\u0000${clubId}\u0000${field}`;
    if (credited.has(key)) return;
    credited.add(key);
    summary[field] += 1;
  };

  const [toEvents, fromEvents] = await Promise.all([
    db
      .from('membership_events')
      .select(membershipColumns)
      .in('to_club_id', clubIds)
      .gte('detected_at', startIso)
      .lt('detected_at', endIso)
      .limit(MAX_EVENT_ROWS),
    db
      .from('membership_events')
      .select(membershipColumns)
      .in('from_club_id', clubIds)
      .gte('detected_at', startIso)
      .lt('detected_at', endIso)
      .limit(MAX_EVENT_ROWS),
  ]);
  requireOk(toEvents.error, 'Read incoming membership events');
  requireOk(fromEvents.error, 'Read outgoing membership events');

  for (const result of [toEvents, fromEvents]) {
    for (const raw of result.data ?? []) {
      const row = asRecord(raw);
      if (row === null || !withinPeriod(row['detected_at'], startMs, endMs)) continue;
      const eventId = asString(row['id']) ?? String(row['id']);
      const fromClubId = asString(row['from_club_id']);
      const toClubId = asString(row['to_club_id']);
      const eventType = asString(row['event_type']);
      if (eventType === 'join') {
        credit(eventId, toClubId, 'joins');
      } else if (eventType === 'leave') {
        credit(eventId, fromClubId, 'leaves');
      } else if (eventType === 'transfer') {
        credit(eventId, fromClubId, 'transfers');
        credit(eventId, toClubId, 'transfers');
        // Per-club summaries count both sides, but the guild total must count
        // the transfer event once even when both clubs belong to this guild.
        transferEventIds.add(eventId);
      }
    }
  }

  const rolesResult = await db
    .from('club_role_changes')
    .select('club_id, detected_at')
    .in('club_id', clubIds)
    .gte('detected_at', startIso)
    .lt('detected_at', endIso)
    .limit(MAX_EVENT_ROWS);
  requireOk(rolesResult.error, 'Read club role changes');
  for (const raw of rolesResult.data ?? []) {
    const row = asRecord(raw);
    if (row === null || !withinPeriod(row['detected_at'], startMs, endMs)) continue;
    const summary = byClub.get(asString(row['club_id']) ?? '');
    if (summary !== undefined) summary.roleChanges += 1;
  }

  const capacityResult = await db
    .from('club_capacity_events')
    .select('club_id, is_full, detected_at')
    .in('club_id', clubIds)
    .gte('detected_at', startIso)
    .lt('detected_at', endIso)
    .limit(MAX_EVENT_ROWS);
  requireOk(capacityResult.error, 'Read club capacity events');
  for (const raw of capacityResult.data ?? []) {
    const row = asRecord(raw);
    if (row === null || !withinPeriod(row['detected_at'], startMs, endMs)) continue;
    const summary = byClub.get(asString(row['club_id']) ?? '');
    if (summary === undefined) continue;
    if (row['is_full'] === true) summary.capacityCloses += 1;
    else if (row['is_full'] === false) summary.capacityOpens += 1;
  }

  const totals: ReportData['totals'] = {
    clubs: summaries.length,
    joins: summaries.reduce((sum, item) => sum + item.joins, 0),
    leaves: summaries.reduce((sum, item) => sum + item.leaves, 0),
    transfers: transferEventIds.size,
    roleChanges: summaries.reduce((sum, item) => sum + item.roleChanges, 0),
    capacityOpens: summaries.reduce((sum, item) => sum + item.capacityOpens, 0),
    capacityCloses: summaries.reduce((sum, item) => sum + item.capacityCloses, 0),
  };
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
  const claimMessageId = reportClaimMessageId(claimId);
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

  // Reserve before any data load or Discord call so two workers cannot both
  // conclude they own the period. A lost race is a skip, never a duplicate.
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
    if (ownsClaim) expectedPriorValue = claimMessageId;

    if (!ownsClaim) {
      const current = await db
        .from('guild_report_posts')
        .select('message_id')
        .eq('guild_id', input.guildId)
        .eq('report_type', input.period.type)
        .eq('period_key', input.period.periodKey)
        .maybeSingle();
      requireOk(current.error, 'Read report post');
      const currentMessageId = asString(asRecord(current.data)?.['message_id']);
      if (currentMessageId === null || currentMessageId === claimMessageId) {
        return { posted: false, messageId: null, skipped: true };
      }
      if (isReportClaim(currentMessageId)) {
        const recoveredId = parseReportDeliveredClaim(currentMessageId);
        if (recoveredId === null) {
          // A post may have been attempted but its ID was never persisted.
          return { posted: false, messageId: null, skipped: true };
        }
        existingMessageId = recoveredId;
        expectedPriorValue = currentMessageId;
      } else {
        existingMessageId = currentMessageId;
        expectedPriorValue = currentMessageId;
      }
    }
  } catch (error: unknown) {
    return { posted: false, messageId: null, error: safeError(error, input.token) };
  }

  let data: ReportData;
  try {
    data = await loadReportData(input.guildId, input.period);
  } catch (error: unknown) {
    await releaseClaim();
    return { posted: false, messageId: null, error: safeError(error, input.token) };
  }

  const embed = buildReportEmbed({
    data,
    guildLabel: input.guildLabel ?? input.guildId,
    now: new Date(),
  });
  const body = {
    embeds: [embed.toJSON()],
    allowed_mentions: { parse: [] },
    flags: 0,
  };

  let messageId: string | null = null;
  if (existingMessageId !== null) {
    try {
      const message = (await input.rest.patch(
        Routes.channelMessage(channelId, existingMessageId),
        { body },
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
      })) as { id?: string } | undefined;
      messageId = asString(message?.id);
    } catch (error: unknown) {
      await releaseClaim();
      return { posted: false, messageId: null, error: safeError(error, input.token) };
    }
    if (messageId === null) {
      await releaseClaim();
      return {
        posted: false,
        messageId: null,
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

export interface MissingReportDeliveries {
  /** Latest fully completed periods with a configured guild still missing a durable message. */
  readonly periods: readonly ReportPeriod[];
  /** Current UTC inactivity day key when a configured guild is still missing a durable post. */
  readonly inactivityPeriodKey: string | null;
}

/**
 * Durable delivery state for the scheduler. Ledger keys are authoritative and
 * scoped per guild, so a restart, a missed UTC boundary, or one failed guild
 * cannot hide another guild's undelivered period.
 */
export async function readMissingReportDeliveries(now: Date): Promise<MissingReportDeliveries> {
  const db = createTrustedClient();
  const expected = REPORT_TYPES.map((type) => latestCompletedReportPeriod(now, type));
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

  const missingTypes = new Set<ReportType>();
  for (const period of expected) {
    const targets = guilds.filter((guild) => reportChannelFor(guild, period.type) !== null);
    if (targets.some((guild) => !posted.has(`${guild.guildId}:${period.type}:${period.periodKey}`))) {
      missingTypes.add(period.type);
    }
  }
  const inactivityMissing = guilds.some(
    (guild) =>
      guild.inactivityDays !== null &&
      guild.inactivityChannelId !== null &&
      !inactivityPosted.has(guild.guildId),
  );

  return {
    periods: expected.filter((period) => missingTypes.has(period.type)),
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

  for (const guild of guilds) {
    for (const type of types) {
      try {
        const period = latestCompletedReportPeriod(now, type);
        const channelId = reportChannelFor(guild, type);
        if (channelId === null) continue;
        const result = await postScheduledReport({
          rest,
          guildId: guild.guildId,
          period,
          channelId,
          token,
          guildLabel: null,
        });
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
            periodKey: period.periodKey,
            messageId: result.messageId,
            error: result.error ?? 'unknown error',
          });
        }
      } catch (error: unknown) {
        failedTypes.add(type);
        logger.warn('Scheduled report failed for guild', {
          guildId: guild.guildId,
          reportType: type,
          error: safeError(error, token),
        });
      }
    }
  }

  return {
    failedTypes: [...failedTypes],
    skippedTypes: [...skippedTypes],
    claimedTypes: [...claimedTypes],
  };
}
