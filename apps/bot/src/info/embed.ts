import { EMBED_COLORS } from '../discord/embed-style';
import { mdBold, mdCode, mdList } from '../discord/embed-format';
import { EmbedBuilder } from 'discord.js';
import type { Page } from '../discord/pagination';
import { ABOUT_SECTIONS, type HelpCategory } from './catalog';
import type { StatusView } from '../status/service';

const INLINE = true;
const MAX_FIELD_LENGTH = 1000;
const CATEGORY_ICONS: Readonly<Record<string, string>> = {
  Club: '🏛️',
  Player: '👤',
  Leaderboard: '🏆',
  'Game data': '🎮',
  Competition: '⚔️',
  Membership: '🤝',
  'Staff and moderation': '🛡️',
  Administration: '⚙️',
  Information: 'ℹ️',
};

function safeText(value: string): string {
  return value.replace(/[`*_<>]/g, '').slice(0, MAX_FIELD_LENGTH);
}

function statusLabel(state: 'ok' | 'unavailable' | 'error'): string {
  if (state === 'ok') return 'OK';
  if (state === 'unavailable') return 'Unavailable';
  return 'Failed';
}

function discordTimestamp(value: Date | null): string {
  if (value === null) return '—';
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return '—';
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function friendlyPermission(text: string): string {
  return text
    .replace('clubs:write', 'club management')
    .replace('members:verify', 'member verification staff')
    .replace('competitions:manage', 'competition management')
    .replace('staff:manage', 'staff management')
    .replace('sync:run', 'sync staff')
    .replace('audit:read', 'audit access');
}

function clampField(value: string): string {
  return value.length <= MAX_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_FIELD_LENGTH - 1).trimEnd()}…`;
}

function formatUsages(usage: string): string {
  return mdList(
    usage.split(/\s+\|\s+/).map((part) => mdCode(part.trim())),
  );
}

function permissionNote(permission: string | undefined): string {
  if (permission === undefined) return '';
  return `🔒 Requires ${friendlyPermission(permission)}.`;
}

function categoryValue(category: HelpCategory): string {
  const lines: string[] = [];

  for (const entry of category.entries) {
    lines.push(mdBold(entry.name), formatUsages(entry.usage));
    lines.push(`   ${safeText(entry.description)}`);

    const note = permissionNote(entry.permission);
    if (note.length > 0) lines.push(`   ${note}`);
  }

  return clampField(lines.join('\n'));
}

export function buildHelpPageEmbed(page: Page<HelpCategory>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.neutral)
    .setTitle('BrawlHub command directory')
    .setDescription(
      `**Page ${page.page} of ${page.pageCount}** · Showing ${page.total} command categories. ` +
        'Only commands available in this build are listed.',
    );

  if (page.page === 1) {
    embed.addFields({
      name: 'How to read this list',
      value: mdList([
        'Type a command exactly as shown.',
        '`[brackets]` mark optional values.',
        '🔒 marks commands that need permission.',
        'Use `/help about` for project details or `/help status` for health.',
      ]),
      inline: false,
    });
  }

  for (const category of page.items) {
    const icon = CATEGORY_ICONS[category.name] ?? '•';
    embed.addFields({ name: `${icon} ${category.name}`, value: categoryValue(category), inline: false });
  }

  embed.setFooter({ text: 'BrawlHub · Commands are scoped to this server' });
  return embed;
}

export function buildAboutEmbed(): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.neutral)
    .setTitle('About BrawlHub')
    .setDescription(
      'BrawlHub is an independent community project. It is not affiliated with or endorsed by Supercell.',
    );

  for (const section of ABOUT_SECTIONS) {
    embed.addFields({ name: section.title, value: safeText(section.body), inline: false });
  }
  return embed;
}

export function buildStatusEmbed(view: StatusView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(view.overall === 'operational' ? EMBED_COLORS.success : EMBED_COLORS.warning)
    .setTitle(view.overall === 'operational' ? 'BrawlHub status: operational' : 'BrawlHub status: degraded')
    .setDescription('Safe public operational information. Raw errors and configuration are never shown.')
    .addFields(
      {
        name: 'Discord bot',
        value: `${statusLabel(view.discord.state)} — ${view.discord.detail}`,
        inline: false,
      },
      {
        name: 'Uptime',
        value: formatUptime(view.discord.uptimeMs),
        inline: INLINE,
      },
      {
        name: 'Connected since',
        value: discordTimestamp(view.discord.connectedAt),
        inline: INLINE,
      },
      {
        name: 'Database',
        value:
          `${statusLabel(view.database.state)} — ${view.database.detail}` +
          `\nRegistered clubs: ${view.database.clubCount === null ? '—' : view.database.clubCount}`,
        inline: false,
      },
      {
        name: 'Brawl Stars API',
        value: `${statusLabel(view.api.state)} — ${view.api.detail}`,
        inline: false,
      },
      {
        name: 'Synchronisation',
        value:
          `${statusLabel(view.sync.state)} — ${view.sync.detail}` +
          `\nLatest status: ${view.sync.status === null ? 'Not recorded' : safeText(view.sync.status)}` +
          `\nLast timestamp: ${discordTimestamp(view.sync.lastTimestamp)}` +
          `\nRunning now: ${view.sync.running ? 'Yes' : 'No'}`,
        inline: false,
      },
      { name: 'Version', value: safeText(view.version), inline: INLINE },
      { name: 'Checked at', value: discordTimestamp(view.generatedAt), inline: INLINE },
    );

  return embed;
}
