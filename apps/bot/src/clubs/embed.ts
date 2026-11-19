import { EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../config';
import {
  cleanTag,
  escapeMarkdown,
  formatEmoji,
  formatInteger,
  formatPlayerLink,
} from '../discord/format';
import { paginate, type Page } from '../discord/pagination';
import { calculateAverage, calculateTrophyProgression, calculateTrophyRange, countRole } from './calculate';
import type {
  ClubLogPeriod,
  ClubLogView,
  ClubSummary,
  ClubView,
  ComparisonSide,
  ComparisonView,
  HistoryPeriod,
  HistoryPoint,
  HistoryView,
  LeaderboardView,
  MemberDetail,
  MemberView,
  RosterMember,
  TrophyProgression,
} from './types';

export const CLUB_MEMBER_CAPACITY = 30;
const EMBED_COLOR = 0x5865_f2;

const ROLE_LABELS: Readonly<Record<string, string>> = {
  notMember: 'Not a member',
  rookie: 'Rookie',
  member: 'Member',
  senior: 'Senior',
  vicePresident: 'Vice-President',
  president: 'President',
};

const HISTORY_LABELS: Readonly<Record<HistoryPeriod, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All available history',
};

const CLUB_LOG_PERIOD_LABELS: Readonly<Record<ClubLogPeriod, string>> = {
  today: 'Today',
  week: 'This Week',
  season: 'This Season',
};

type EmbedConfig = Pick<
  BotConfig,
  'emojis' | 'playerProfileUrlTemplate' | 'seasonStartIso'
>;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/** Keep every new embed inside Discord's 6,000-character total limit. */
export function fitEmbedToDiscordLimits(embed: EmbedBuilder): EmbedBuilder {
  const data = embed.toJSON();
  const fields = data.fields ?? [];
  if (fields.length === 0) return embed;

  const baseLength =
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text.length ?? 0) +
    (data.author?.name?.length ?? 0);
  const measure = (nameLimit: number, valueLimit: number) =>
    baseLength +
    fields.reduce(
      (total, field) =>
        total + Math.min(field.name.length, nameLimit) + Math.min(field.value.length, valueLimit),
      0,
    );

  let nameLimit = 256;
  let valueLimit = 1024;
  while (measure(nameLimit, valueLimit) > 6000 && valueLimit > 32) {
    valueLimit = Math.max(32, valueLimit - 64);
  }
  while (measure(nameLimit, valueLimit) > 6000 && nameLimit > 64) {
    nameLimit = Math.max(64, nameLimit - 32);
  }

  embed.setFields(
    fields.map((field) => ({
      ...field,
      name: truncate(field.name, nameLimit),
      value: truncate(field.value, valueLimit),
    })),
  );
  return embed;
}

function displayTag(tag: string): string {
  return `#${cleanTag(tag)}`;
}

function label(emoji: string, text: string): string {
  return `${emoji}${text}`;
}

function formatDelta(value: number): string {
  const formatted = formatInteger(value) ?? '0';
  return value > 0 ? `+${formatted}` : formatted;
}

/** Discord relative timestamp for a stored ISO value. */
export function formatSyncTime(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return `<t:${Math.floor(milliseconds / 1000)}:R>`;
}

function president(roster: readonly RosterMember[]): RosterMember | null {
  return roster.find((member) => member.role === 'president' && member.name !== '') ?? null;
}

function formatClubType(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized === '') return null;
  switch (normalized) {
    case 'open':
      return 'Open';
    case 'closed':
      return 'Closed';
    case 'inviteOnly':
      return 'Invite Only';
    default:
      return normalized
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (char) => char.toUpperCase());
  }
}

function progressionSummary(view: ClubView, config: EmbedConfig, now: Date): string | null {
  const progression = calculateTrophyProgression({
    snapshots: view.snapshots,
    currentTrophies: view.currentTrophies,
    currentAt: view.currentAt,
    now,
    seasonStartIso: config.seasonStartIso,
  });

  const parts: string[] = [];
  if (progression.today !== null) parts.push(`Today ${formatDelta(progression.today)}`);
  if (progression.week !== null) parts.push(`Week ${formatDelta(progression.week)}`);
  if (progression.season !== null) parts.push(`Season ${formatDelta(progression.season)}`);
  return parts.length === 0 ? null : parts.join('  ');
}

/** Build the detailed `/club` embed. */
export function buildClubEmbed(
  view: ClubView,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  const emoji = {
    trophies: formatEmoji(config.emojis.trophies, 'trophies'),
    trophyRange: formatEmoji(config.emojis.trophyRange, 'trophy_range'),
    president: formatEmoji(config.emojis.president, 'president'),
    requiredTrophies: formatEmoji(config.emojis.requiredTrophies, 'required_trophies'),
    members: formatEmoji(config.emojis.members, 'members'),
    progression: formatEmoji(config.emojis.progression, 'progression'),
    description: formatEmoji(config.emojis.description, 'description'),
  };

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${escapeMarkdown(view.club.name)} • ${displayTag(view.club.tag)}`, 256))
    .setTimestamp(now);

  if (view.badgeId !== null) {
    embed.setThumbnail(`https://cdn.brawlify.com/club-badges/regular/${view.badgeId}.png`);
  }

  const total = formatInteger(view.currentTrophies);
  const average = view.rosterAvailable
    ? formatInteger(calculateAverage(view.roster.map((member) => member.trophies)))
    : null;
  if (total !== null || average !== null) {
    const parts: string[] = [];
    if (total !== null) parts.push(`${emoji.trophies}${total}`);
    if (average !== null) parts.push(`Average ${emoji.trophies}${average}`);
    embed.addFields({
      name: 'Trophies',
      value: truncate(parts.join('  '), 1024),
    });
  }

  const range = view.rosterAvailable ? calculateTrophyRange(view.roster) : null;
  if (range !== null) {
    embed.addFields({
      name: 'Trophy Range',
      value: truncate(`${emoji.trophyRange}${formatInteger(range.low)} - ${formatInteger(range.high)}`, 1024),
    });
  }

  const leader = view.rosterAvailable ? president(view.roster) : null;
  if (leader !== null) {
    embed.addFields({
      name: 'President',
      value: truncate(
        formatPlayerLink(leader.name, leader.tag, config.playerProfileUrlTemplate),
        1024,
      ),
    });
  }

  const required = formatInteger(view.requiredTrophies);
  if (required !== null) {
    embed.addFields({
      name: 'Required Trophies',
      value: truncate(`${emoji.requiredTrophies}${required}`, 1024),
    });
  }

  const type = formatClubType(view.type);
  if (type !== null) {
    embed.addFields({
      name: 'Type',
      value: truncate(type, 1024),
    });
  }

  if (view.rosterAvailable) {
    const lines = [`${emoji.members}${view.roster.length}/${CLUB_MEMBER_CAPACITY}`];
    const vicePresidents = countRole(view.roster, 'vicePresident');
    const seniors = countRole(view.roster, 'senior');
    if (vicePresidents !== null) lines.push(`${emoji.members}Vice-Presidents ${vicePresidents}`);
    if (seniors !== null) lines.push(`${emoji.members}Seniors ${seniors}`);
    embed.addFields({ name: 'Members', value: truncate(lines.join('\n'), 1024) });
  }

  const activity = view.matchActivity;
  if (activity !== null && (activity.today !== null || activity.week !== null || activity.season !== null)) {
    const parts: string[] = [];
    if (activity.today !== null) parts.push(`T ${formatInteger(activity.today)}`);
    if (activity.week !== null) parts.push(`W ${formatInteger(activity.week)}`);
    if (activity.season !== null) parts.push(`S ${formatInteger(activity.season)}`);
    const matchesEmoji = formatEmoji(config.emojis.matches, 'matches');
    const lastBattle = formatSyncTime(activity.lastBattleAt);
    const lines = [`${matchesEmoji}${parts.join(' | ')}`.trim()];
    if (lastBattle !== null) lines.push(`Last battle: ${lastBattle}`);
    embed.addFields({
      name: 'Average Matches Played',
      value: truncate(lines.join('\n'), 1024),
    });
  } else if (activity?.lastBattleAt) {
    const lastBattle = formatSyncTime(activity.lastBattleAt);
    if (lastBattle !== null) {
      embed.addFields({
        name: 'Last Activity',
        value: truncate(`Last battle: ${lastBattle}`, 1024),
      });
    }
  }

  const progression = progressionSummary(view, config, now);
  if (progression !== null) {
    embed.addFields({
      name: 'Trophy Progression',
      value: truncate(progression, 1024),
    });
  }

  const megaPig = view.megaPigEstimate;
  if (megaPig !== null && megaPig.sampleSize > 0) {
    const lines = [
      `Matches: ${formatInteger(megaPig.matches)}`,
      `Wins: ${formatInteger(megaPig.wins)}`,
      `Trophy Δ: ${formatDelta(megaPig.trophyChange)}`,
    ];
    embed.addFields({
      name: 'Mega Pig (estimated)',
      value: truncate(lines.join(' • '), 1024),
    });
  }

  const description = view.description?.trim();
  if (description !== undefined && description !== '') {
    embed.addFields({
      name: 'Description',
      value: truncate(escapeMarkdown(description), 1024),
    });
  }

  const footer: string[] = [
    view.liveStatus === 'live' ? 'Live official API data' : 'Latest synced data',
  ];
  const syncedAt = formatSyncTime(view.latestSyncAt);
  if (syncedAt !== null) footer.push(`Synced ${syncedAt}`);
  embed.setFooter({ text: truncate(footer.join(' • '), 2048) });

  return fitEmbedToDiscordLimits(embed);
}

/** Build a compact, paginated `/clubs` embed. */
export function buildClubsPageEmbed(
  summaries: readonly ClubSummary[],
  page: Page<ClubSummary>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Registered Clubs')
    .setFooter({
      text: `Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`,
    });

  if (page.items.length === 0) {
    embed.setDescription('No clubs are registered with BrawlHub yet.');
    return embed;
  }

  page.items.forEach((summary, index) => {
    const average = formatInteger(summary.averageTrophies);
    const members = formatInteger(summary.memberCount);
    const syncedAt = formatSyncTime(summary.latestSyncAt) ?? 'Not yet synced';
    const lines = [`Total: ${formatInteger(summary.totalTrophies) ?? '—'}`];
    if (average !== null) lines.push(`Average: ${average}`);
    if (members !== null) lines.push(`Members: ${members} / ${CLUB_MEMBER_CAPACITY}`);
    lines.push(`Last sync: ${syncedAt}`);

    embed.addFields({
      name: truncate(`${page.start + index}. ${escapeMarkdown(summary.club.name)} • ${displayTag(summary.club.tag)}`, 256),
      value: truncate(lines.join('\n'), 1024),
    });
  });

  return embed;
}

export function paginateClubs(
  summaries: readonly ClubSummary[],
  page: number,
  pageSize = 5,
): Page<ClubSummary> {
  return paginate(summaries, page, pageSize);
}

/** Discord absolute timestamp for a stored ISO value. */
export function formatAbsoluteTime(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return `<t:${Math.floor(milliseconds / 1000)}:f>`;
}

function formatProgressionLines(
  progression: TrophyProgression | null,
  prefix: string,
): string[] {
  if (progression === null) return [];
  const lines: string[] = [];
  if (progression.today !== null) lines.push(`${prefix}Today: ${formatDelta(progression.today)}`);
  if (progression.week !== null) lines.push(`${prefix}Week: ${formatDelta(progression.week)}`);
  if (progression.season !== null) lines.push(`${prefix}Season: ${formatDelta(progression.season)}`);
  return lines;
}

function memberName(member: RosterMember, config: EmbedConfig): string {
  const name = member.name === '' ? `#${cleanTag(member.tag)}` : member.name;
  return formatPlayerLink(name, member.tag, config.playerProfileUrlTemplate);
}

function pageFooter(page: Page<unknown>, label: string): string {
  return `${label} • Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`;
}

/** Build a page of the latest synchronised club roster. */
export function buildClubMembersPageEmbed(
  view: MemberView,
  page: Page<MemberDetail>,
  config: EmbedConfig,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${escapeMarkdown(view.club.name)} • ${displayTag(view.club.tag)} — Members`, 256))
    .setFooter({ text: truncate(pageFooter(page, 'Roster'), 2048) });

  const sync = formatSyncTime(view.latestSnapshot?.capturedAt ?? view.latestSyncAt);
  embed.setDescription(
    truncate(
      `Current roster: ${view.members.length} / ${CLUB_MEMBER_CAPACITY}` +
        (sync === null ? '' : ` • Latest snapshot ${sync}`),
      2048,
    ),
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Roster',
      value: view.members.length === 0
        ? 'No members are stored for this club.'
        : 'No members on this page.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((member, index) => {
    const lines = [`Tag: ${displayTag(member.tag)}`];
    const current = formatInteger(member.trophies);
    const highest = formatInteger(member.highestTrophies);
    const role = member.role === null ? null : ROLE_LABELS[member.role];
    if (current !== null) lines.push(`Current trophies: ${current}`);
    if (highest !== null) lines.push(`Highest trophies: ${highest}`);
    if (role !== undefined) lines.push(`Role: ${role}`);

    embed.addFields({
      name: truncate(`${page.start + index}. ${memberName(member, config)}`, 256),
      value: truncate(lines.join('\n'), 1024),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build a page of the club trophy leaderboard. */
export function buildLeaderboardPageEmbed(
  view: LeaderboardView,
  page: Page<LeaderboardView['entries'][number]>,
  config: EmbedConfig,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      truncate(`${escapeMarkdown(view.club.name)} • ${displayTag(view.club.tag)} — Trophy Leaderboard`, 256),
    )
    .setFooter({ text: truncate(pageFooter(page, 'Leaderboard'), 2048) });

  const snapshotAt = formatAbsoluteTime(view.latestSnapshot?.capturedAt);
  embed.setDescription(
    truncate(
      `${view.entries.length} ranked member${view.entries.length === 1 ? '' : 's'}` +
        (snapshotAt === null ? '' : ` • Snapshot ${snapshotAt}`),
      2048,
    ),
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Leaderboard',
      value: 'No members have valid stored trophy data for this club.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((entry) => {
    const lines = [`Current trophies: ${formatInteger(entry.trophies) ?? '—'}`];
    lines.push(...formatProgressionLines(entry.progression, 'Historical '));
    embed.addFields({
      name: truncate(
        `#${entry.rank} ${memberName(entry, config)} • ${displayTag(entry.tag)}`,
        256,
      ),
      value: truncate(lines.join('\n'), 1024),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

function historyPointValue(point: HistoryPoint): string {
  const lines: string[] = [];
  const trophies = formatInteger(point.trophies);
  const average = formatInteger(point.averageTrophies);
  const members = formatInteger(point.memberCount);
  if (trophies !== null) lines.push(`Club trophies: ${trophies}`);
  if (average !== null) lines.push(`Average member trophies: ${average}`);
  if (members !== null) lines.push(`Members: ${members}`);
  return lines.length === 0 ? 'Snapshot contains no stored values.' : lines.join('\n');
}

function addHistoryChangeField(
  embed: EmbedBuilder,
  name: string,
  value: number | null,
  suffix: string,
): void {
  const formatted = formatInteger(value);
  if (formatted !== null) {
    embed.addFields({ name, value: `${suffix}: ${formatDelta(value ?? 0)}` });
  }
}

/** Build a paginated club history embed with stored snapshots and changes. */
export function buildHistoryPageEmbed(
  view: HistoryView,
  page: Page<HistoryPoint>,
  config: EmbedConfig,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      truncate(`${escapeMarkdown(view.club.name)} • ${displayTag(view.club.tag)} — History`, 256),
    )
    .setFooter({ text: truncate(pageFooter(page, HISTORY_LABELS[view.period]), 2048) });

  const latest = formatAbsoluteTime(view.latestSnapshotAt);
  embed.setDescription(
    truncate(
      `${HISTORY_LABELS[view.period]} • Latest snapshot: ${latest ?? 'none stored'}`,
      2048,
    ),
  );

  const rangeStart = formatAbsoluteTime(view.rangeStart);
  const rangeEnd = formatAbsoluteTime(view.rangeEnd);
  embed.addFields({
    name: 'Available Range',
    value:
      rangeStart === null || rangeEnd === null
        ? 'No stored snapshots in this period.'
        : `${rangeStart} → ${rangeEnd}\n${view.points.length} stored snapshot${view.points.length === 1 ? '' : 's'}`,
  });

  const change = view.change;
  if (change === null) {
    embed.addFields({
      name: 'Changes',
      value:
        view.points.length === 0
          ? 'No stored snapshots to compare.'
          : 'At least two stored snapshots are required to calculate changes.',
    });
  } else {
    addHistoryChangeField(embed, 'Club Trophies', change.trophies, 'Change');
    addHistoryChangeField(embed, 'Average Member Trophies', change.averageTrophies, 'Change');
    addHistoryChangeField(embed, 'Member Count', change.memberCount, 'Change');
  }

  const progression = formatProgressionLines(view.progression, '');
  if (progression.length > 0) {
    embed.addFields({
      name: 'Trophy Progression',
      value: truncate(progression.join('\n'), 1024),
    });
  }

  if (page.items.length === 0) {
    embed.addFields({ name: 'Snapshots', value: 'No stored snapshots in this period.' });
  } else {
    page.items.forEach((point) => {
      embed.addFields({
        name: truncate(formatAbsoluteTime(point.capturedAt) ?? point.capturedAt, 256),
        value: truncate(historyPointValue(point), 1024),
      });
    });
  }

  if (view.membershipChanges.length > 0 && page.page === 1) {
    const lines = view.membershipChanges.slice(0, 5).map((change) => {
      const name =
        change.playerName === null
          ? (change.playerTag === null ? 'A player' : displayTag(change.playerTag))
          : formatPlayerLink(change.playerName, change.playerTag ?? '', config.playerProfileUrlTemplate);
      const action =
        change.eventType === 'join' ? 'joined' : change.eventType === 'leave' ? 'left' : 'transferred';
      const detectedAt = formatSyncTime(change.detectedAt);
      return `• ${name} ${action}${detectedAt === null ? '' : ` (detected ${detectedAt})`}`;
    });
    embed.addFields({
      name: 'Membership Changes',
      value: truncate(lines.join('\n'), 1024),
    });
  }

  return fitEmbedToDiscordLimits(embed);
}

function comparisonSideName(side: ComparisonSide): string {
  return `${escapeMarkdown(side.club.name)} (#${cleanTag(side.club.tag)})`;
}

function addComparisonMetric(
  embed: EmbedBuilder,
  view: ComparisonView,
  name: string,
  firstValue: number | null,
  secondValue: number | null,
  formatter: (value: number) => string,
): void {
  const firstText = formatter(firstValue ?? 0);
  const secondText = formatter(secondValue ?? 0);
  if (firstValue === null || secondValue === null) return;

  const lines = [
    `${comparisonSideName(view.first)}: ${firstText}`,
    `${comparisonSideName(view.second)}: ${secondText}`,
  ];
  if (firstValue > secondValue) {
    lines.push(`Leader: ${comparisonSideName(view.first)}`);
  } else if (secondValue > firstValue) {
    lines.push(`Leader: ${comparisonSideName(view.second)}`);
  } else {
    lines.push('Leader: Tied');
  }

  embed.addFields({ name, value: truncate(lines.join('\n'), 1024) });
}

/** Build the two-club comparison embed from aligned or clearly marked data. */
export function buildCompareEmbed(view: ComparisonView, config: EmbedConfig): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Club Comparison')
    .setDescription(
      view.aligned
        ? `Both clubs are compared from the same completed sync: ${formatAbsoluteTime(view.first.snapshotAt) ?? 'unknown time'}`
        : 'These clubs are compared from different completed sync times; compare with care.',
    );

  addComparisonMetric(embed, view, 'Total Trophies', view.first.trophies, view.second.trophies, (value) => formatInteger(value) ?? '0');
  addComparisonMetric(embed, view, 'Average Member Trophies', view.first.averageTrophies, view.second.averageTrophies, (value) => formatInteger(value) ?? '0');
  addComparisonMetric(embed, view, 'Member Count', view.first.memberCount, view.second.memberCount, (value) => `${value} / ${CLUB_MEMBER_CAPACITY}`);
  addComparisonMetric(embed, view, 'Highest Member Trophies', view.first.highestTrophies, view.second.highestTrophies, (value) => formatInteger(value) ?? '0');
  addComparisonMetric(embed, view, 'Lowest Member Trophies', view.first.lowestTrophies, view.second.lowestTrophies, (value) => formatInteger(value) ?? '0');

  const windows: ReadonlyArray<{ readonly key: keyof TrophyProgression; readonly name: string }> = [
    { key: 'today', name: 'Trophy Progression · Today' },
    { key: 'week', name: 'Trophy Progression · Week' },
    { key: 'season', name: 'Trophy Progression · Season' },
  ];
  for (const window of windows) {
    addComparisonMetric(
      embed,
      view,
      window.name,
      view.first.progression?.[window.key] ?? null,
      view.second.progression?.[window.key] ?? null,
      (value) => formatDelta(value),
    );
  }

  const syncLines = [
    `${comparisonSideName(view.first)}: ${formatSyncTime(view.first.latestSyncAt) ?? 'not yet synced'}`,
    `${comparisonSideName(view.second)}: ${formatSyncTime(view.second.latestSyncAt) ?? 'not yet synced'}`,
  ];
  embed.addFields({
    name: 'Latest Successful Sync',
    value: truncate(syncLines.join('\n'), 1024),
  });

  const firstSnapshot = formatAbsoluteTime(view.first.snapshotAt);
  const secondSnapshot = formatAbsoluteTime(view.second.snapshotAt);
  embed.addFields({
    name: 'Snapshot Times',
    value: truncate(
      `${comparisonSideName(view.first)}: ${firstSnapshot ?? 'club row only'}\n` +
        `${comparisonSideName(view.second)}: ${secondSnapshot ?? 'club row only'}` +
        (view.aligned ? '\nAligned to the same completed sync.' : '\nDifferent snapshot times.'),
      1024,
    ),
  });

  embed.setFooter({
    text: truncate(
      view.aligned
        ? 'Source: matching completed sync'
        : 'Source: latest available completed sync per club',
      2048,
    ),
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build a paginated club trophy-change log for a daily/weekly period. */
export function buildClubLogPageEmbed(
  view: ClubLogView,
  page: Page<ClubLogView['rows'][number]>,
  config: EmbedConfig,
): EmbedBuilder {
  const trophy = formatEmoji(config.emojis.trophies, 'trophies');
  const periodLabel = CLUB_LOG_PERIOD_LABELS[view.period];
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      truncate(
        `${escapeMarkdown(view.club.name)} • ${displayTag(view.club.tag)} — Club Log`,
        256,
      ),
    )
    .setFooter({ text: truncate(pageFooter(page, periodLabel), 2048) });

  const snapshotAt = formatAbsoluteTime(view.latestSnapshotAt);
  const syncAt = formatSyncTime(view.latestSyncAt);
  const meta: string[] = [`Trophy Progression • ${periodLabel}`];
  if (snapshotAt !== null) meta.push(`Snapshot ${snapshotAt}`);
  if (syncAt !== null) meta.push(`Synced ${syncAt}`);
  if (view.unavailable > 0) {
    meta.push(
      `${view.unavailable} member${view.unavailable === 1 ? '' : 's'} without a stored baseline for this period`,
    );
  }
  embed.setDescription(truncate(meta.join(' • '), 2048));

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Trophy Progression',
      value:
        view.rows.length === 0
          ? 'No stored trophy progression is available for this period yet. At least one completed sync snapshot at or before the period boundary is required.'
          : 'No members on this page.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  const lines = page.items.map((row) => {
    const name = memberName(row.member, config);
    return `${row.rank}. ${name} ${trophy}${formatDelta(row.change)}`;
  });

  embed.addFields({
    name: `${periodLabel} Trophy Change`,
    value: truncate(lines.join('\n'), 1024),
  });

  return fitEmbedToDiscordLimits(embed);
}
