import sharp from 'sharp';
import { cleanTag } from '../../discord/format';
import type { ClubLogView } from '../types';
import { CLUB_LOG_PERIOD_LABELS } from './page-view';
import type { ClubLogEvent } from './types';

/**
 * Render stored club-log data as PNG bytes. Every visible value comes from the
 * guild's stored official-API snapshots and change events; no live Brawl Stars
 * request is made here. Three layouts are available:
 *  - buildClubLogPageImage: combined page used by `/clubs log preview`
 *  - buildClubLogDigestImage: trophy progression only (scheduled digest)
 *  - buildClubLogEventImage: joins/leaves/roles/capacity only (scheduled event log)
 */

const WIDTH = 1200;
const ROW_HEIGHT = 44;
const EVENT_HEIGHT = 68;
const MAX_ROWS = 30;
const MAX_EVENTS = 20;
const MAX_INPUT_PIXELS = 24_000_000;

const KIND_LABELS: Readonly<Record<ClubLogEvent['kind'], string>> = {
  membership: 'Membership',
  role: 'Role updated',
  capacity: 'Capacity',
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function clean(value: string, maxLength: number, fallback = '—'): string {
  const sanitized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<[@#&](?:!?\d+|everyone|here)>/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized === '') return fallback;
  const characters = Array.from(sanitized);
  return escapeXml(
    characters.length <= maxLength ? sanitized : `${characters.slice(0, maxLength - 1).join('')}…`,
  );
}

function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : Math.trunc(value).toLocaleString('en-US');
}

function formatDelta(value: number): string {
  const formatted = new Intl.NumberFormat('en-US').format(Math.abs(value));
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

function formatDate(value: string | null): string {
  if (value === null) return 'No timestamp';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'No timestamp';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(parsed);
}

function initials(tag: string): string {
  const characters = Array.from(cleanTag(tag)).filter((character) => /[A-Z0-9]/.test(character));
  if (characters.length === 0) return 'BH';
  return characters.slice(0, 2).join('');
}

function roleLabel(role: string | null): string {
  if (role === null || role.trim() === '') return 'No role';
  const normalized = role.replaceAll('_', ' ').trim();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function deltaColor(value: number): string {
  if (value > 0) return '#7de2a0';
  if (value < 0) return '#ff8fab';
  return '#cfc9ff';
}

function stat(x: number, label: string, value: string, accent: string): string {
  return `<rect x="${x}" y="146" width="262" height="78" rx="18" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.09"/>
    <text x="${x + 20}" y="174" font-size="13" font-weight="700" letter-spacing="1.6" fill="${accent}">${escapeXml(label.toUpperCase())}</text>
    <text x="${x + 20}" y="205" font-size="21" font-weight="700" fill="#f7f6ff">${clean(value, 24)}</text>`;
}

function rowMarkup(row: ClubLogView['rows'][number], y: number): string {
  const name = clean(row.member.name, 28, 'Unknown player');
  const tag = clean(`#${row.member.tag}`, 14);
  const role = clean(roleLabel(row.member.role), 18);
  const trophies = formatInteger(row.member.trophies);
  const change = formatDelta(row.change);
  return `<rect x="60" y="${y}" width="1080" height="38" rx="12" fill="#ffffff" fill-opacity="0.045"/>
    <text x="80" y="${y + 25}" font-size="17" font-weight="700" fill="#8f82ff">${row.rank}</text>
    <text x="122" y="${y + 25}" font-size="17" font-weight="700" fill="#f7f6ff">${name}</text>
    <text x="470" y="${y + 25}" font-size="15" fill="#aaa5d6">${tag}</text>
    <text x="650" y="${y + 25}" font-size="15" fill="#cfc9ff">${role}</text>
    <text x="900" y="${y + 25}" font-size="15" fill="#aaa5d6">${trophies}</text>
    <text x="1110" y="${y + 25}" text-anchor="end" font-size="18" font-weight="700" fill="${deltaColor(row.change)}">${change}</text>`;
}

function eventMarkup(event: ClubLogEvent, y: number): string {
  const label = KIND_LABELS[event.kind];
  const timestamp = clean(formatDate(event.detectedAt), 28);
  return `<rect x="60" y="${y}" width="1080" height="56" rx="14" fill="#ffffff" fill-opacity="0.045" stroke="#ffffff" stroke-opacity="0.07"/>
    <rect x="76" y="${y + 13}" width="126" height="30" rx="15" fill="#8f82ff" fill-opacity="0.2" stroke="#8f82ff" stroke-opacity="0.6"/>
    <text x="139" y="${y + 33}" text-anchor="middle" font-size="12" font-weight="700" letter-spacing="0.9" fill="#dcd6ff">${escapeXml(label.toUpperCase())}</text>
    <text x="222" y="${y + 33}" font-size="16" font-weight="600" fill="#f7f6ff">${clean(event.description, 72, 'Stored change')}</text>
    <text x="1116" y="${y + 33}" text-anchor="end" font-size="13" fill="#8e88bd">${timestamp}</text>`;
}

/** Shared background/frame markup for all club-log layouts. */
function frame(height: number): string {
  return `<defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11102b"/>
      <stop offset="58%" stop-color="#1b1645"/>
      <stop offset="100%" stop-color="#39226f"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#292353"/>
      <stop offset="100%" stop-color="#1a1639"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${height}" fill="url(#background)"/>
  <circle cx="1120" cy="30" r="260" fill="#9a7dff" fill-opacity="0.11"/>
  <circle cx="1090" cy="${height - 40}" r="190" fill="#46d6ff" fill-opacity="0.07"/>`;
}

function header(title: string, rightLabel: string): string {
  return `<rect x="42" y="34" width="344" height="44" rx="22" fill="#ffffff" fill-opacity="0.08"/>
  <text x="64" y="63" font-size="17" font-weight="700" letter-spacing="2.2" fill="#dcd6ff">${escapeXml(title)}</text>
  <text x="1158" y="63" text-anchor="end" font-size="14" font-weight="700" letter-spacing="1.4" fill="#aaa5d6">${escapeXml(rightLabel)}</text>`;
}

function clubHeading(tag: string, name: string, subtitle: string): string {
  return `<rect x="60" y="96" width="72" height="72" rx="20" fill="#8f82ff" fill-opacity="0.22" stroke="#8f82ff" stroke-opacity="0.7"/>
  <text x="96" y="142" text-anchor="middle" font-size="27" font-weight="700" fill="#dcd6ff">${escapeXml(initials(tag))}</text>
  <text x="154" y="126" font-size="38" font-weight="700" fill="#f7f6ff">${clean(name, 34, 'Unnamed club')}</text>
  <text x="155" y="157" font-size="19" font-weight="600" fill="#aaa5d6">${clean(`#${cleanTag(tag)}`, 14)} • ${clean(subtitle, 52)}</text>`;
}

function toPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg), { limitInputPixels: MAX_INPUT_PIXELS })
    .png()
    .toBuffer();
}

/** Render BrawlHub's stored full-page club log as PNG bytes (preview layout). */
export async function buildClubLogPageImage(
  view: ClubLogView,
  events: readonly ClubLogEvent[] = [],
): Promise<Buffer> {
  const periodLabel = CLUB_LOG_PERIOD_LABELS[view.period];
  const rows = view.rows.slice(0, MAX_ROWS);
  const changes = events.slice(0, MAX_EVENTS);
  const rowsTop = 308;
  const changesTitleY = rowsTop + Math.max(rows.length, 1) * ROW_HEIGHT + 46;
  const eventsTop = changesTitleY + 28;
  const footerY = eventsTop + Math.max(changes.length, 1) * EVENT_HEIGHT + 34;
  const height = Math.max(760, footerY + 62);

  const rowsMarkup =
    rows.length === 0
      ? `<rect x="60" y="${rowsTop}" width="1080" height="38" rx="12" fill="#ffffff" fill-opacity="0.035"/>
         <text x="80" y="${rowsTop + 25}" font-size="16" fill="#aaa5d6">No stored trophy progression is available for this period yet.</text>`
      : rows.map((row, index) => rowMarkup(row, rowsTop + index * ROW_HEIGHT)).join('');

  const changesMarkup =
    changes.length === 0
      ? `<rect x="60" y="${eventsTop}" width="1080" height="56" rx="14" fill="#ffffff" fill-opacity="0.035"/>
         <text x="80" y="${eventsTop + 34}" font-size="16" fill="#aaa5d6">No recent stored changes to show.</text>`
      : changes.map((event, index) => eventMarkup(event, eventsTop + index * EVENT_HEIGHT)).join('');

  const clubName = clean(view.club.name, 34, 'Unnamed club');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  ${frame(height)}
  ${header('BRAWLHUB • CLUB LOGS', 'STORED OFFICIAL DATA')}
  ${clubHeading(view.club.tag, view.club.name, `Trophy Progression / ${periodLabel}`)}
  ${stat(60, 'Period', periodLabel, '#8f82ff')}
  ${stat(338, 'Members in page', String(rows.length), '#46d6ff')}
  ${stat(616, 'Snapshot', formatDate(view.latestSnapshotAt), '#ffd166')}
  ${stat(894, 'Synced', formatDate(view.latestSyncAt), '#7de2a0')}
  <rect x="42" y="250" width="1116" height="${height - 300}" rx="30" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="60" y="${rowsTop - 18}" font-size="15" font-weight="700" letter-spacing="1.7" fill="#aaa5d6">TROPHY PROGRESSION • ${escapeXml(periodLabel.toUpperCase())}</text>
  <text x="1116" y="${rowsTop - 18}" text-anchor="end" font-size="13" fill="#8e88bd">${view.unavailable} WITHOUT BASELINE</text>
  ${rowsMarkup}
  <text x="60" y="${changesTitleY}" font-size="15" font-weight="700" letter-spacing="1.7" fill="#aaa5d6">RECENT STORED CHANGES</text>
  <text x="1116" y="${changesTitleY}" text-anchor="end" font-size="13" fill="#8e88bd">${changes.length} SHOWN</text>
  ${changesMarkup}
  <text x="42" y="${footerY}" font-size="13" fill="#8e88bd">Official Brawl Stars sync history • stored, not live • static BrawlAPI assets are never used as data</text>
  <text x="1158" y="${footerY}" text-anchor="end" font-size="13" fill="#8e88bd">Made for ${clubName}</text>
</svg>`;

  return toPng(svg);
}

/**
 * Scheduled trophy digest: progression rows only, with no membership/role/capacity
 * events. The period label is supplied by the caller so completed windows can be
 * named "Daily"/"Weekly"/"Season" rather than the running "Today"/"This Week".
 */
export async function buildClubLogDigestImage(
  view: ClubLogView,
  labelOverride?: string,
): Promise<Buffer> {
  const periodLabel = labelOverride ?? CLUB_LOG_PERIOD_LABELS[view.period];
  const rows = view.rows.slice(0, MAX_ROWS);
  const rowsTop = 308;
  const footerY = rowsTop + Math.max(rows.length, 1) * ROW_HEIGHT + 48;
  const height = Math.max(620, footerY + 62);

  const rowsMarkup =
    rows.length === 0
      ? `<rect x="60" y="${rowsTop}" width="1080" height="38" rx="12" fill="#ffffff" fill-opacity="0.035"/>
         <text x="80" y="${rowsTop + 25}" font-size="16" fill="#aaa5d6">No stored trophy progression is available for this window yet.</text>`
      : rows.map((row, index) => rowMarkup(row, rowsTop + index * ROW_HEIGHT)).join('');

  const clubName = clean(view.club.name, 34, 'Unnamed club');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  ${frame(height)}
  ${header('BRAWLHUB • CLUB LOGS', 'TROPHY DIGEST')}
  ${clubHeading(view.club.tag, view.club.name, `Trophy Progression / ${periodLabel}`)}
  ${stat(60, 'Period', periodLabel, '#8f82ff')}
  ${stat(338, 'Members in page', String(rows.length), '#46d6ff')}
  ${stat(616, 'Snapshot', formatDate(view.latestSnapshotAt), '#ffd166')}
  ${stat(894, 'Synced', formatDate(view.latestSyncAt), '#7de2a0')}
  <rect x="42" y="250" width="1116" height="${height - 300}" rx="30" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="60" y="${rowsTop - 18}" font-size="15" font-weight="700" letter-spacing="1.7" fill="#aaa5d6">TROPHY PROGRESSION • ${escapeXml(periodLabel.toUpperCase())}</text>
  <text x="1116" y="${rowsTop - 18}" text-anchor="end" font-size="13" fill="#8e88bd">${view.unavailable} WITHOUT BASELINE</text>
  ${rowsMarkup}
  <text x="42" y="${footerY}" font-size="13" fill="#8e88bd">Completed window • official Brawl Stars sync history • stored, not live • missing baselines are never shown as +0</text>
  <text x="1158" y="${footerY}" text-anchor="end" font-size="13" fill="#8e88bd">Made for ${clubName}</text>
</svg>`;

  return toPng(svg);
}

/** Scheduled event log: joins, leaves, transfers, role/capacity changes only. */
export async function buildClubLogEventImage(
  club: { readonly name: string; readonly tag: string },
  events: readonly ClubLogEvent[],
): Promise<Buffer> {
  const changes = events.slice(0, MAX_EVENTS);
  const eventsTop = 308;
  const footerY = eventsTop + Math.max(changes.length, 1) * EVENT_HEIGHT + 34;
  const height = Math.max(620, footerY + 62);

  const changesMarkup =
    changes.length === 0
      ? `<rect x="60" y="${eventsTop}" width="1080" height="56" rx="14" fill="#ffffff" fill-opacity="0.035"/>
         <text x="80" y="${eventsTop + 34}" font-size="16" fill="#aaa5d6">No stored changes since the last event log.</text>`
      : changes.map((event, index) => eventMarkup(event, eventsTop + index * EVENT_HEIGHT)).join('');

  const membershipCount = changes.filter((event) => event.kind === 'membership').length;
  const roleCount = changes.filter((event) => event.kind === 'role').length;
  const capacityCount = changes.filter((event) => event.kind === 'capacity').length;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  ${frame(height)}
  ${header('BRAWLHUB • CLUB LOGS', 'MEMBERS & ROLES')}
  ${clubHeading(club.tag, club.name, 'Members & Roles / Stored Changes')}
  ${stat(60, 'Changes', String(changes.length), '#8f82ff')}
  ${stat(338, 'Membership', String(membershipCount), '#46d6ff')}
  ${stat(616, 'Role updates', String(roleCount), '#ffd166')}
  ${stat(894, 'Capacity', String(capacityCount), '#7de2a0')}
  <rect x="42" y="250" width="1116" height="${height - 300}" rx="30" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="60" y="${eventsTop - 18}" font-size="15" font-weight="700" letter-spacing="1.7" fill="#aaa5d6">RECENT STORED CHANGES</text>
  <text x="1116" y="${eventsTop - 18}" text-anchor="end" font-size="13" fill="#8e88bd">${changes.length} SHOWN</text>
  ${changesMarkup}
  <text x="42" y="${footerY}" font-size="13" fill="#8e88bd">Official Brawl Stars sync history • stored, not live • no trophy data is shown here</text>
  <text x="1158" y="${footerY}" text-anchor="end" font-size="13" fill="#8e88bd">Made for ${clean(club.name, 34, 'club')}</text>
</svg>`;

  return toPng(svg);
}
