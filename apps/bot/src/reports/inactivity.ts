import { mdBold, mdCode, mdList, mdParagraphs, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import { EmbedBuilder, REST, Routes } from 'discord.js';
import type { AdminActor } from '../admin/types';
import { recordAdminAudit } from '../admin/service';
import { fitEmbedToDiscordLimits } from '../clubs/embed';

const logger = createLogger('bot/inactivity');
const DAY_MS = 86_400_000;
const REDACTED = '[REDACTED]';
const MAX_INACTIVE_PER_CLUB = 8;

export const MIN_INACTIVITY_DAYS = 1;
export const MAX_INACTIVITY_DAYS = 365;

function safeError(error: unknown, token?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (token !== undefined && token !== '' && message.includes(token)) {
    return message.split(token).join(REDACTED);
  }
  return message;
}

function clean(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return 'unknown';
  const sanitized = value.replace(/[\r\n\t]+/g, ' ').replace(/[<@>`]/g, '').trim();
  return sanitized === '' ? 'unknown' : sanitized.slice(0, maxLength);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push([...values.slice(index, index + size)]);
  }
  return result;
}

/** Validate and normalize a stored/configured inactivity threshold. */
export function normalizeInactivityDays(value: unknown): number | null {
  const days = asNumber(value);
  if (days === null || days < MIN_INACTIVITY_DAYS || days > MAX_INACTIVITY_DAYS) return null;
  return Math.floor(days);
}

interface InactivityClubRecord {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
}

interface InactivityMembershipRecord {
  readonly clubId: string;
  readonly playerId: string;
  readonly role: string | null;
}

export interface InactivityMember {
  readonly clubTag: string;
  readonly clubName: string;
  readonly playerTag: string;
  readonly playerName: string;
  readonly role: string | null;
  readonly daysInactive: number | null;
}

export interface InactivityClubSummary {
  readonly tag: string;
  readonly name: string;
  readonly members: number;
  readonly inactive: number;
}

export interface InactivityData {
  readonly guildId: string;
  readonly thresholdDays: number;
  readonly generatedAt: string;
  readonly clubs: readonly InactivityClubSummary[];
  readonly inactive: readonly InactivityMember[];
  readonly totalMembers: number;
}

/** Load inactivity data from stored official sync data for one guild only. */
export async function loadInactivityData(
  guildId: string,
  thresholdDays: number,
  now: Date,
  db: SupabaseClient = createTrustedClient(),
): Promise<InactivityData> {
  const clubResult = await db
    .from('clubs')
    .select('id, tag, name')
    .eq('guild_id', guildId)
    .is('archived_at', null);
  if (clubResult.error) throw new Error(`Read clubs failed: ${clubResult.error.message}`);

  const clubs = (clubResult.data ?? [])
    .map((row: unknown) => {
      const item = record(row);
      const id = asString(item?.['id']);
      const tag = asString(item?.['tag']);
      if (id === null || tag === null) return null;
      return { id, tag, name: clean(item?.['name'], 60) };
    })
    .filter((club): club is InactivityClubRecord => club !== null);
  if (clubs.length === 0) {
    return { guildId, thresholdDays, generatedAt: now.toISOString(), clubs: [], inactive: [], totalMembers: 0 };
  }

  const membershipResult = await db
    .from('club_memberships')
    .select('club_id, player_id, role')
    .in('club_id', clubs.map((club) => club.id))
    .is('valid_to', null);
  if (membershipResult.error) {
    throw new Error(`Read memberships failed: ${membershipResult.error.message}`);
  }
  const memberships = (membershipResult.data ?? [])
    .map((row: unknown) => {
      const item = record(row);
      const clubId = asString(item?.['club_id']);
      const playerId = asString(item?.['player_id']);
      if (clubId === null || playerId === null) return null;
      return { clubId, playerId, role: asString(item?.['role']) };
    })
    .filter((member): member is InactivityMembershipRecord => member !== null);

  const playerIds = [...new Set(memberships.map((member) => member.playerId))];
  const players = new Map<string, { tag: string; name: string; lastBattleAt: string | null }>();
  for (const ids of chunk(playerIds, 100)) {
    const result = await db
      .from('players')
      .select('id, tag, name, last_battle_at')
      .in('id', ids);
    if (result.error) throw new Error(`Read players failed: ${result.error.message}`);
    for (const row of result.data ?? []) {
      const item = record(row);
      const id = asString(item?.['id']);
      const tag = asString(item?.['tag']);
      if (id === null || tag === null) continue;
      players.set(id, {
        tag,
        name: clean(item?.['name'], 60),
        lastBattleAt: asString(item?.['last_battle_at']),
      });
    }
  }

  const inactive: InactivityMember[] = [];
  const summaries: InactivityClubSummary[] = [];
  for (const club of clubs) {
    const clubMemberships = memberships.filter((member) => member.clubId === club.id);
    let inactiveCount = 0;
    for (const membership of clubMemberships) {
      const player = players.get(membership.playerId);
      if (player === undefined) continue;
      const last = player.lastBattleAt === null ? Number.NaN : Date.parse(player.lastBattleAt);
      const days =
        Number.isNaN(last) || now.getTime() < last ? null : Math.floor((now.getTime() - last) / DAY_MS);
      if (days !== null && days < thresholdDays) continue;
      inactiveCount += 1;
      inactive.push({
        clubTag: club.tag,
        clubName: club.name,
        playerTag: player.tag,
        playerName: player.name,
        role: membership.role,
        daysInactive: days,
      });
    }
    summaries.push({ tag: club.tag, name: club.name, members: clubMemberships.length, inactive: inactiveCount });
  }

  inactive.sort((left, right) => {
    if (left.daysInactive === null && right.daysInactive === null) return 0;
    if (left.daysInactive === null) return 1;
    if (right.daysInactive === null) return -1;
    return right.daysInactive - left.daysInactive;
  });
  return {
    guildId,
    thresholdDays,
    generatedAt: now.toISOString(),
    clubs: summaries,
    inactive,
    totalMembers: memberships.length,
  };
}

export function buildInactivityEmbed(data: InactivityData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.report)
    .setTitle('Club inactivity report')
    .setDescription(
      mdSection(
        'Inactivity',
        `Members with no stored battle for ${mdBold(`${data.thresholdDays}+ day(s)`)} across ${data.clubs.length} registered club(s).`,
      ),
    )
    .addFields({
      name: 'Summary',
      value: `${mdBold(String(data.inactive.length))} inactive of ${mdBold(String(data.totalMembers))} synced members`,
    });

  for (const club of data.clubs) {
    const inactiveMembers = data.inactive.filter((member) => member.clubTag === club.tag);
    const rows = inactiveMembers
      .slice(0, MAX_INACTIVE_PER_CLUB)
      .map((member) => {
        const days = member.daysInactive === null ? 'never recorded' : `${member.daysInactive}d`;
        return `${clean(member.playerName, 40)} (${mdCode(`#${member.playerTag}`)}) — ${days}`;
      });
    const hidden = inactiveMembers.length - MAX_INACTIVE_PER_CLUB;
    if (hidden > 0) rows.push(`…and ${hidden} more`);
    embed.addFields({
      name: `${club.name} (#${club.tag})`,
      value: mdParagraphs(mdBold(`${club.inactive}/${club.members} inactive`), mdList(rows)),
    });
  }

  const generatedAt = Date.parse(data.generatedAt);
  embed.setFooter({
    text: `Stored battle activity, not Discord presence${
      Number.isNaN(generatedAt) ? '' : ` • <t:${Math.floor(generatedAt / 1000)}:f>`
    }`,
  });
  return fitEmbedToDiscordLimits(embed);
}

/** Embed used by the staff-only inactivity configuration command. */
export function buildInactivitySettingsEmbed(
  guildId: string,
  settings: InactivitySettings,
  notice?: string | undefined,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.report)
    .setTitle('Inactivity report settings')
    .setDescription(notice ?? `Configuration for this Discord server. Server ID: \`${guildId}\`.`)
    .addFields(
      {
        name: 'Status',
        value: mdBold(settings.days === null ? 'Disabled' : 'Enabled'),
        inline: true,
      },
      {
        name: 'Alert threshold',
        value:
          settings.days === null
            ? 'No members are flagged until a threshold is set.'
            : `Members with no stored battle for ${mdBold(`${settings.days}+ day(s)`)} are flagged.`,
        inline: true,
      },
      {
        name: 'Destination',
        value:
          settings.channelId === null
            ? 'Overview channel fallback (not configured)'
            : `<#${settings.channelId}>`,
        inline: true,
      },
      {
        name: 'Schedule',
        value: mdList([
          'Auto-posts once daily at 00:00 UTC.',
          'No immediate or on-demand report posts.',
        ]),
      },
      {
        name: 'Data source',
        value: mdList([
          'Stored official Brawl Stars battle activity.',
          'No extra API calls are made.',
        ]),
      },
    );
  return fitEmbedToDiscordLimits(embed);
}

export interface InactivitySettings {
  readonly days: number | null;
  readonly channelId: string | null;
}

export async function readInactivitySettings(
  guildId: string,
  db: SupabaseClient = createTrustedClient(),
): Promise<InactivitySettings> {
  const { data, error } = await db
    .from('guild_settings')
    .select('report_inactivity_days, report_inactivity_channel_id, overview_channel_id')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) throw new Error(`Read inactivity settings failed: ${error.message}`);
  const row = record(data);
  return {
    days: normalizeInactivityDays(row?.['report_inactivity_days']),
    channelId:
      asString(row?.['report_inactivity_channel_id']) ?? asString(row?.['overview_channel_id']),
  };
}

export async function updateInactivitySettings(
  input: {
    readonly guildId: string;
    readonly days: number | null;
    readonly channelId: string | null;
    readonly actor: AdminActor;
  },
  db: SupabaseClient = createTrustedClient(),
): Promise<InactivitySettings> {
  const days = normalizeInactivityDays(input.days);
  if (input.days !== null && days === null) {
    throw new Error(`Inactivity threshold must be between ${MIN_INACTIVITY_DAYS} and ${MAX_INACTIVITY_DAYS} days.`);
  }
  const channelId = input.channelId === null ? null : input.channelId.trim();
  if (channelId !== null && !/^\d{17,20}$/.test(channelId)) {
    throw new Error('Inactivity report channel must be a Discord channel ID.');
  }

  const saved = await db.from('guild_settings').upsert(
    {
      guild_id: input.guildId,
      report_inactivity_days: days,
      report_inactivity_channel_id: channelId,
    },
    { onConflict: 'guild_id' },
  );
  if (saved.error) throw new Error(`Save inactivity settings failed: ${saved.error.message}`);
  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'guild.inactivity_report.updated',
      targetType: 'guild',
      targetId: input.guildId,
      guildId: input.guildId,
      details: { days, channelId },
    },
    { db },
  );
  return readInactivitySettings(input.guildId, db);
}

interface InactivityPostRow {
  readonly messageId: string;
  readonly channelId: string;
}

async function readInactivityPost(
  guildId: string,
  periodKey: string,
  db: SupabaseClient,
): Promise<InactivityPostRow | null> {
  const { data, error } = await db
    .from('guild_inactivity_report_posts')
    .select('message_id, channel_id')
    .eq('guild_id', guildId)
    .eq('period_key', periodKey)
    .maybeSingle();
  if (error) throw new Error(`Read inactivity report post failed: ${error.message}`);
  const row = record(data);
  const messageId = asString(row?.['message_id']);
  const channelId = asString(row?.['channel_id']);
  return messageId === null || channelId === null ? null : { messageId, channelId };
}

/** Post the inactivity digest once per guild and UTC day, editing replays in place. */
export async function postInactivityReports(
  now: Date,
  rest: REST,
  token: string | undefined,
  db: SupabaseClient = createTrustedClient(),
): Promise<number> {
  const settings = await db
    .from('guild_settings')
    .select('guild_id, report_inactivity_days, report_inactivity_channel_id, overview_channel_id')
    .not('report_inactivity_days', 'is', null);
  if (settings.error) {
    logger.warn('Could not read inactivity report guilds', { error: safeError(settings.error, token) });
    return 0;
  }

  const periodKey = now.toISOString().slice(0, 10);
  let posted = 0;
  for (const row of settings.data ?? []) {
    const item = record(row);
    const guildId = asString(item?.['guild_id']);
    const days = normalizeInactivityDays(item?.['report_inactivity_days']);
    if (guildId === null || days === null) continue;
    const channelId =
      asString(item?.['report_inactivity_channel_id']) ?? asString(item?.['overview_channel_id']);
    if (channelId === null) continue;

    try {
      const data = await loadInactivityData(guildId, Math.floor(days), now, db);
      const embed = buildInactivityEmbed(data);
      const body = { embeds: [embed.toJSON()], allowed_mentions: { parse: [] }, flags: 0 };
      const existing = await readInactivityPost(guildId, periodKey, db);
      let messageId: string | null = null;
      if (existing !== null) {
        try {
          const message = (await rest.patch(Routes.channelMessage(channelId, existing.messageId), {
            body,
          })) as { id?: string } | undefined;
          messageId = asString(message?.id) ?? existing.messageId;
        } catch (editError: unknown) {
          if (!String(editError).includes('Unknown Message')) throw editError;
        }
      }
      if (messageId === null) {
        const message = (await rest.post(Routes.channelMessages(channelId), {
          body,
        })) as { id?: string } | undefined;
        messageId = asString(message?.id);
        if (messageId === null) throw new Error('Discord inactivity post returned no message ID');
      }
      const saved = await db.from('guild_inactivity_report_posts').upsert(
        { guild_id: guildId, period_key: periodKey, channel_id: channelId, message_id: messageId },
        { onConflict: 'guild_id,period_key' },
      );
      if (saved.error) throw new Error(`Record inactivity post failed: ${saved.error.message}`);
      posted += 1;
    } catch (error: unknown) {
      logger.warn('Inactivity report failed for guild', {
        guildId,
        error: safeError(error, token),
      });
    }
  }
  return posted;
}
