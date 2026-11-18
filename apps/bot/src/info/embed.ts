import { EmbedBuilder } from 'discord.js';
import type { Page } from '../discord/pagination';
import { ABOUT_SECTIONS, type HelpCategory } from './catalog';
import type { StatusView } from '../status/service';

const INLINE = true;
const MAX_FIELD_LENGTH = 1000;

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

function categoryValue(category: HelpCategory): string {
  const lines = category.entries.map((entry) => {
    const permission = entry.permission === undefined ? '' : ` — requires ${entry.permission}`;
    return `\`${entry.usage}\` — ${entry.description}${permission}`;
  });
  return lines.join('\n').slice(0, MAX_FIELD_LENGTH);
}

export function buildHelpPageEmbed(page: Page<HelpCategory>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('BrawlHub command directory')
    .setDescription(
      `Page ${page.page} of ${page.pageCount}. Showing ${page.total} command categories. ` +
        'Only commands available in this build are listed.',
    );

  for (const category of page.items) {
    embed.addFields({ name: category.name, value: categoryValue(category), inline: false });
  }
  return embed;
}

export function buildAboutEmbed(): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865_f2)
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
    .setColor(view.overall === 'operational' ? 0x57f2_87 : 0xfaa_61a)
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
