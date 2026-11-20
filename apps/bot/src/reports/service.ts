import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../config';
import { buildReportEmbed } from './embed';
import {
  currentReportPeriod,
  REPORT_TYPES,
  reportChannelFor,
  type ReportChannelSettings,
  type ReportPeriod,
  type ReportType,
} from './period';
import type { MutableClubSummary, ReportClubSummary, ReportPostRow } from './types';

const logger = createLogger('bot');
const REDACTED = '[REDACTED]';
const MAX_REPORT_CLUBS = 25;
const MAX_EVENT_ROWS = 10_000;

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
  readonly error?: string;
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

function parsePostRow(value: unknown): ReportPostRow | null {
  const candidate = asRecord(value);
  if (candidate === null) return null;
  return {
    messageId: asString(candidate['message_id']),
    channelId: asString(candidate['channel_id']),
  };
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
    transfers: summaries.reduce((sum, item) => sum + item.transfers, 0),
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

  let data: ReportData;
  try {
    data = await loadReportData(input.guildId, input.period);
  } catch (error: unknown) {
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
  const db = createTrustedClient();

  let existing: ReportPostRow | null = null;
  try {
    const result = await db
      .from('guild_report_posts')
      .select('message_id, channel_id')
      .eq('guild_id', input.guildId)
      .eq('report_type', input.period.type)
      .eq('period_key', input.period.periodKey)
      .maybeSingle();
    requireOk(result.error, 'Read report post');
    existing = parsePostRow(result.data);
  } catch (error: unknown) {
    return { posted: false, messageId: null, error: safeError(error, input.token) };
  }

  let messageId: string | null = null;
  if (existing?.messageId !== null && existing?.messageId !== undefined) {
    try {
      const message = (await input.rest.patch(
        Routes.channelMessage(channelId, existing.messageId),
        { body },
      )) as { id?: string } | undefined;
      messageId = asString(message?.id) ?? existing.messageId;
    } catch (error: unknown) {
      if (!isUnknownMessage(error)) {
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
      return { posted: false, messageId: null, error: safeError(error, input.token) };
    }
    if (messageId === null) {
      return {
        posted: false,
        messageId: null,
        error: 'Discord report post returned no message ID',
      };
    }
  }

  try {
    const { error } = await db.from('guild_report_posts').upsert(
      {
        guild_id: input.guildId,
        report_type: input.period.type,
        period_key: input.period.periodKey,
        channel_id: channelId,
        message_id: messageId,
      },
      { onConflict: 'guild_id,report_type,period_key' },
    );
    requireOk(error, 'Record report post');
  } catch (error: unknown) {
    return { posted: true, messageId, error: safeError(error, input.token) };
  }

  return { posted: true, messageId };
}

interface ScheduledGuild extends ReportChannelSettings {
  readonly guildId: string;
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
): Promise<void> {
  const token = getBotConfig().token;
  if (token === undefined) {
    logger.warn('Scheduled reports skipped: DISCORD_TOKEN is not configured');
    return;
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
    return;
  }

  if (guilds.length === 0) return;
  const rest = new REST({ version: '10' }).setToken(token);

  for (const guild of guilds) {
    for (const type of types) {
      try {
        const period = currentReportPeriod(now, type);
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
        if (!result.posted) {
          logger.warn('Scheduled report was not posted', {
            guildId: guild.guildId,
            reportType: type,
            periodKey: period.periodKey,
            error: result.error ?? 'unknown error',
          });
        }
      } catch (error: unknown) {
        logger.warn('Scheduled report failed for guild', {
          guildId: guild.guildId,
          reportType: type,
          error: safeError(error, token),
        });
      }
    }
  }
}
