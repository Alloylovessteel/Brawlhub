import sharp from 'sharp';
import { cleanTag } from '../discord/format';
import type { ReportData } from './service';
import { CLUB_CAPACITY, type ReportClubSummary } from './types';

const WIDTH = 1200;
const MAX_CLUB_ROWS = 30;
const METRICS = [
  ['joins', 'Joins'],
  ['leaves', 'Leaves'],
  ['transfers', 'Transfers'],
  ['roleChanges', 'Role changes'],
] as const;

function xmlText(value: string, max = 100): string {
  const chars = Array.from(value.replace(/[\p{Cc}\p{Cs}\uFFFE\uFFFF]/gu, ' ').trim());
  const text = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function capacityText(club: ReportClubSummary): { label: string; color: string } {
  const count = club.capacity.memberCount;
  if (count === null) return { label: 'Unknown', color: '#b0a5d3' };
  if (count >= CLUB_CAPACITY) {
    return { label: `${CLUB_CAPACITY}/${CLUB_CAPACITY} full`, color: '#ffd08a' };
  }
  const open = Math.max(0, CLUB_CAPACITY - count);
  return { label: `${open}/${CLUB_CAPACITY} open`, color: '#fff' };
}

export function reportImageTitle(period: ReportData['period']): string {
  const label = period.type.charAt(0).toUpperCase() + period.type.slice(1);
  return `${label} club report • ${period.periodKey}`;
}

export function describeReportImage(data: ReportData): string {
  const counts = METRICS.map(([key, label]) => `${label}: ${data.totals[key]}`).join('; ');
  const capacity =
    `Capacity from latest completed snapshot: ${data.totals.openClubs} open, ` +
    `${data.totals.fullClubs} full, ${data.totals.unknownClubs} unknown`;
  return (
    `${reportImageTitle(data.period)}. ` +
    `${data.period.start.toISOString()} to ${data.period.end.toISOString()} (UTC, end exclusive). ` +
    `Clubs: ${data.totals.clubs}; ${counts}; ${capacity}.`
  );
}

/** Render guild totals and per-club stored activity with current club capacity. */
export async function buildReportImage(data: ReportData, guildLabel: string): Promise<Buffer> {
  const clubs = data.clubSummaries.slice(0, MAX_CLUB_ROWS);
  const omitted = data.clubSummaries.length - clubs.length;
  const hasActivity = METRICS.some(([key]) => data.totals[key] > 0);
  const tableTop = 334;
  const rowHeight = 52;
  const footerY = tableTop + Math.max(clubs.length, 1) * rowHeight + 40;
  const height = footerY + 30;
  const columnX = (index: number): number => 465 + index * 125;
  const columns = [...METRICS.map(([, label]) => label), 'Capacity']
    .map(
      (label, index) =>
        `<text x="${columnX(index)}" y="314" text-anchor="middle">${label}</text>`,
    )
    .join('');
  const totals = [
    ['Clubs', data.totals.clubs],
    ...METRICS.map(([key, label]) => [label, data.totals[key]] as const),
    ['Open', data.totals.openClubs],
    ['Full', data.totals.fullClubs],
  ]
    .map(([label, value], index) => {
      const x = 40 + index * 162;
      return `<rect x="${x}" y="164" width="148" height="76" rx="14" fill="#302659"/>
        <text x="${x + 14}" y="189" font-size="14" fill="#cdc3f8">${label}</text>
        <text x="${x + 14}" y="221" font-size="25" font-weight="700">${value.toLocaleString('en-US')}</text>`;
    })
    .join('');
  const rows = clubs
    .map((club, index) => {
      const y = tableTop + index * rowHeight;
      const tag = cleanTag(club.tag);
      const capacity = capacityText(club);
      return `<rect x="40" y="${y}" width="1120" height="46" rx="10" fill="#302659"/>
        <text x="56" y="${y + 20}" font-size="17" font-weight="700" clip-path="url(#club-column)">${xmlText(club.name, 44) || 'Unnamed club'}</text>
        <text x="56" y="${y + 37}" font-size="13" fill="#cdc3f8">${tag === '' ? 'No tag' : `#${xmlText(tag, 18)}`}</text>
        ${METRICS.map(([key], i) => `<text x="${columnX(i)}" y="${y + 29}" font-size="18" text-anchor="middle" fill="${club[key] === 0 ? '#b0a5d3' : '#fff'}">${club[key].toLocaleString('en-US')}</text>`).join('')}
        <text x="${columnX(METRICS.length)}" y="${y + 29}" font-size="16" text-anchor="middle" fill="${capacity.color}">${capacity.label}</text>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">
    <defs><linearGradient id="bg" x2="100%" y2="100%"><stop stop-color="#11102b"/><stop offset="1" stop-color="#39226f"/></linearGradient>
    <clipPath id="club-column"><rect x="56" width="328" height="${height}"/></clipPath></defs>
    <rect width="${WIDTH}" height="${height}" fill="url(#bg)"/>
    <g font-family="sans-serif" fill="#f7f6ff">
      <text x="40" y="44" font-size="15" font-weight="700" letter-spacing="2" fill="#cdc3f8">BRAWLHUB • STORED ACTIVITY</text>
      <text x="40" y="88" font-size="34" font-weight="700">${xmlText(reportImageTitle(data.period))}</text>
      <text x="40" y="118" font-size="18" fill="#cdc3f8">${xmlText(guildLabel, 80) || 'Unknown guild'}</text>
      <text x="40" y="143" font-size="15" fill="#cdc3f8">${data.period.start.toISOString()} — ${data.period.end.toISOString()} (UTC, end exclusive)</text>
      ${totals}
      <text x="40" y="275" font-size="17" fill="#cdc3f8">${hasActivity ? 'Activity by club' : 'No stored events in this window'}</text>
      <g font-size="14" font-weight="700" fill="#cdc3f8"><text x="56" y="314">Club</text>${columns}</g>
      ${clubs.length === 0 ? '<text x="56" y="365" font-size="16">No active clubs</text>' : rows}
      <text x="40" y="${footerY}" font-size="14" fill="#cdc3f8">Capacity uses the latest completed sync snapshot • ${omitted > 0 ? `Showing ${clubs.length} of ${data.clubSummaries.length} clubs; totals include all clubs` : 'Guild totals count each transfer once'}</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
