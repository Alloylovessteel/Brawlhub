import sharp from 'sharp';
import type { PlayerSeasonWindow } from '../players/card.js';
import type { PlayerProfileView } from '../players/types.js';

/**
 * Composite season-progress PNG. Graphs come only from the stored-data chart
 * service; every headline value comes from the official player profile.
 */

const WIDTH = 1200;
const HEIGHT = 860;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatNumber(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('en-US').format(value);
}

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'not configured';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'not configured';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export interface SeasonProgressCardInput {
  readonly profile: PlayerProfileView;
  readonly seasonWindow: PlayerSeasonWindow | undefined;
  readonly trophyChartPng: Buffer;
  readonly activityChartPng: Buffer;
}

/** Build the graph-heavy Season Progress image used by `/me image mode:season`. */
export async function buildSeasonProgressImage(
  input: SeasonProgressCardInput,
): Promise<Buffer> {
  const player = input.profile.player;
  const wins = [player.threeVsThreeVictories, player.soloVictories, player.duoVictories].reduce<number>(
    (total, value) => total + (value ?? 0),
    0,
  );
  const start = formatDate(input.seasonWindow?.start);
  const end = formatDate(input.seasonWindow?.end);
  const sourceLabel = input.profile.source === 'live' ? 'LIVE OFFICIAL DATA' : 'STORED OFFICIAL DATA';

  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11102b"/>
      <stop offset="55%" stop-color="#1c1748"/>
      <stop offset="100%" stop-color="#34216b"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#292353"/>
      <stop offset="100%" stop-color="#1b173c"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <circle cx="1120" cy="30" r="240" fill="#9a7dff" fill-opacity="0.12"/>
  <circle cx="1080" cy="${HEIGHT - 20}" r="190" fill="#46d6ff" fill-opacity="0.07"/>
  <rect x="40" y="30" width="392" height="44" rx="22" fill="#ffffff" fill-opacity="0.08"/>
  <text x="62" y="59" font-size="17" font-weight="700" letter-spacing="2.2" fill="#dcd6ff">BRAWLHUB • SEASON PROGRESS</text>
  <text x="1160" y="59" text-anchor="end" font-size="14" font-weight="700" letter-spacing="1.4" fill="#aaa5d6">${escapeXml(sourceLabel)}</text>

  <text x="40" y="132" font-size="38" font-weight="700" fill="#f7f6ff">${escapeXml(player.name)}</text>
  <text x="40" y="164" font-size="20" fill="#aaa5d6">#${escapeXml(player.tag)} • ${escapeXml(input.profile.currentClub?.name ?? 'No club recorded')}</text>
  <text x="1160" y="132" text-anchor="end" font-size="26" font-weight="700" fill="#46d6ff">${formatNumber(player.trophies)} 🏆</text>
  <text x="1160" y="164" text-anchor="end" font-size="18" fill="#ffd166">${escapeXml(player.rankedRankName ?? player.highestSeasonRankedRankName ?? '—')} • ${formatNumber(player.fame)} fame</text>

  <rect x="40" y="188" width="1120" height="34" rx="17" fill="#ffffff" fill-opacity="0.055"/>
  <text x="58" y="211" font-size="14" fill="#cfc9ff">Season window: ${escapeXml(start)} → ${escapeXml(end)} • ${formatNumber(wins)} recorded wins • ${formatNumber(input.profile.stats?.brawlerCount ?? input.profile.brawlers.length)} brawlers</text>

  <rect x="40" y="240" width="552" height="374" rx="22" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="62" y="270" font-size="14" font-weight="700" letter-spacing="1.6" fill="#46d6ff">TROPHY GRAPH • STORED SNAPSHOTS</text>
  <rect x="608" y="240" width="552" height="374" rx="22" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="630" y="270" font-size="14" font-weight="700" letter-spacing="1.6" fill="#8f82ff">MATCHES PER DAY • STORED BATTLES</text>

  <rect x="40" y="634" width="1120" height="176" rx="22" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="62" y="668" font-size="14" font-weight="700" letter-spacing="1.6" fill="#7de2a0">CURRENT OFFICIAL SEASON VALUES</text>
  <text x="62" y="716" font-size="24" font-weight="700" fill="#f7f6ff">3v3 ${formatNumber(player.threeVsThreeVictories)}</text>
  <text x="332" y="716" font-size="24" font-weight="700" fill="#f7f6ff">Solo ${formatNumber(player.soloVictories)}</text>
  <text x="612" y="716" font-size="24" font-weight="700" fill="#f7f6ff">Duo ${formatNumber(player.duoVictories)}</text>
  <text x="862" y="716" font-size="24" font-weight="700" fill="#f7f6ff">Peak ${formatNumber(player.highestTrophies)}</text>
  <text x="62" y="764" font-size="14" fill="#8e88bd">Graphs are built only from synced official snapshots/battles. No invented deltas or placeholder history.</text>
  <text x="40" y="842" font-size="13" fill="#8e88bd">Official Brawl Stars data • Static BrawlAPI assets • BrawlHub season progress</text>
</svg>`;

  const backgroundPng = await sharp(Buffer.from(background)).png().toBuffer();
  const trophyChart = await sharp(input.trophyChartPng).resize(524, 306, { fit: 'fill' }).toBuffer();
  const activityChart = await sharp(input.activityChartPng).resize(524, 306, { fit: 'fill' }).toBuffer();

  return sharp(backgroundPng)
    .composite([
      { input: trophyChart, left: 54, top: 284 },
      { input: activityChart, left: 622, top: 284 },
    ])
    .png()
    .toBuffer();
}
