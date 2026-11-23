import sharp from 'sharp';
import type {
  PlayerCardAssets,
  PlayerCardMode,
  PlayerCardOptions,
  PlayerSnapshotPoint,
} from '../players/card.js';
import type { PlayerBrawler, PlayerProfileView } from '../players/types.js';

/**
 * BrawlTools-style player images.
 *
 * Visual direction: plain light background, yellow profile header, white stat
 * panels and large readable values. No dark/purple dashboard treatment. Every
 * number comes from the official Brawl Stars player payload or from stored
 * guild-scoped history; no historical values are invented.
 */

export interface BrawlToolsCharts {
  readonly trophyChartPng: Buffer | null;
  readonly activityChartPng: Buffer | null;
}

const COLORS = {
  background: '#f4f5f7',
  header: '#ffd34d',
  headerLine: '#e8b51c',
  headerText: '#1f2430',
  headerMuted: '#6b5a12',
  panel: '#ffffff',
  border: '#e2e5eb',
  text: '#1f2430',
  muted: '#6b7280',
  faint: '#9aa1ad',
  blue: '#2fbcff',
  gold: '#f5b70d',
  green: '#39c07a',
  gray: '#8b94a3',
} as const;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);
}

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return 'BS';
  if (parts.length === 1) return Array.from(parts[0] ?? 'BS').slice(0, 2).join('').toUpperCase();
  return `${Array.from(parts[0] ?? '')[0] ?? ''}${Array.from(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
}

function svgDocument(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">
    <rect width="${width}" height="${height}" fill="${COLORS.background}"/>
    ${body}
  </svg>`;
}

async function assetDataUrl(url: string | null | undefined, size: number): Promise<string | null> {
  if (url === null || url === undefined || url.trim() === '') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'user-agent': 'BrawlHub Discord bot' },
    });
    if (!response.ok) return null;
    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(response.headers.get('content-type') ?? '')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > 2 * 1024 * 1024) return null;
    const png = await sharp(buffer, { failOn: 'error', limitInputPixels: 16_000_000 })
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

function avatarMarkup(dataUrl: string | null, name: string, x: number, y: number, size: number): string {
  const id = `avatarClip${x}_${y}`;
  if (dataUrl !== null) {
    return `<defs><clipPath id="${id}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath></defs>
      <image href="${dataUrl}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#ffffff" stroke="#d1d5db" stroke-width="3"/>
    <text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" text-anchor="middle" font-size="${Math.round(size * 0.3)}" font-weight="700" fill="${COLORS.text}">${escapeXml(initials(name))}</text>`;
}

function panel(x: number, y: number, width: number, height: number): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>`;
}

function statTile(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
  accent: string = COLORS.blue,
  sub: string | null = null,
): string {
  return `${panel(x, y, width, height)}
    <rect x="${x + 1}" y="${y + 20}" width="5" height="${height - 40}" rx="3" fill="${accent}"/>
    <text x="${x + 22}" y="${y + 32}" font-size="12" font-weight="700" letter-spacing="1.2" fill="${COLORS.muted}">${escapeXml(label.toUpperCase())}</text>
    <text x="${x + 22}" y="${y + height - 24}" font-size="28" font-weight="700" fill="${COLORS.text}">${escapeXml(truncate(value, 20))}</text>
    ${sub === null ? '' : `<text x="${x + width - 20}" y="${y + height - 26}" text-anchor="end" font-size="12" fill="${COLORS.muted}">${escapeXml(truncate(sub, 22))}</text>`}`;
}

function sectionTitle(x: number, y: number, title: string, hint: string | null = null): string {
  return `<text x="${x}" y="${y}" font-size="18" font-weight="700" fill="${COLORS.text}">${escapeXml(title)}</text>
    ${hint === null ? '' : `<text x="${x}" y="${y + 22}" font-size="12" fill="${COLORS.muted}">${escapeXml(truncate(hint, 88))}</text>`}`;
}

function footer(text: string, x: number, y: number): string {
  return `<text x="${x}" y="${y}" font-size="11" fill="${COLORS.faint}">${escapeXml(text)}</text>`;
}

function summaryRow(x: number, y: number, label: string, value: string): string {
  return `<text x="${x}" y="${y}" font-size="14" fill="${COLORS.muted}">${escapeXml(label)}</text>
    <text x="${x + 380}" y="${y}" text-anchor="end" font-size="14" font-weight="700" fill="${COLORS.text}">${escapeXml(truncate(value, 24))}</text>`;
}

function rankedLine(player: PlayerProfileView['player']): string {
  return player.rankedRankName ?? player.highestSeasonRankedRankName ?? '—';
}

function badgeLine(badges: readonly string[] | undefined, x: number, y: number): string {
  const labels = (badges ?? []).map((badge) => badge.trim().toUpperCase()).filter((badge) => badge.length > 0);
  if (labels.length === 0) return '';
  return `<text x="${x}" y="${y}" font-size="11" font-weight="700" letter-spacing="1.2" fill="${COLORS.green}">${escapeXml(labels.slice(0, 3).join(' • '))}</text>`;
}

function profileHeader(
  profile: PlayerProfileView,
  icon: string | null,
  clubBadge: string | null,
  badges: readonly string[] | undefined,
): string {
  const player = profile.player;
  const club = profile.currentClub?.name ?? 'No club recorded';
  const rank = rankedLine(player);
  const clubY = badges?.length ? 142 : 126;
  const clubX = clubBadge === null ? 174 : 220;
  return `<rect x="0" y="0" width="1200" height="176" fill="${COLORS.header}"/>
    <rect x="0" y="176" width="1200" height="4" fill="${COLORS.headerLine}"/>
    ${avatarMarkup(icon, player.name, 32, 32, 112)}
    <text x="172" y="64" font-size="38" font-weight="700" fill="${COLORS.headerText}">${escapeXml(truncate(player.name, 24))}</text>
    <text x="174" y="94" font-size="16" fill="${COLORS.headerMuted}">#${escapeXml(player.tag)}</text>
    ${badgeLine(badges, 174, 116)}
    ${clubBadge === null ? '' : `<image href="${clubBadge}" x="174" y="${clubY - 24}" width="34" height="34" rx="8" preserveAspectRatio="xMidYMid slice"/>`}
    <text x="${clubX}" y="${clubY}" font-size="16" font-weight="700" fill="${COLORS.headerText}">${escapeXml(truncate(club, 30))}</text>
    <text x="${clubX}" y="${clubY + 22}" font-size="12" fill="${COLORS.headerMuted}">${escapeXml(truncate(player.fameTierName ?? rank, 38))}</text>
    <text x="1168" y="66" text-anchor="end" font-size="13" font-weight="700" letter-spacing="1.4" fill="${COLORS.headerMuted}">TROPHIES</text>
    <text x="1168" y="120" text-anchor="end" font-size="48" font-weight="700" fill="${COLORS.headerText}">${formatNumber(player.trophies)}</text>
    <text x="1168" y="150" text-anchor="end" font-size="13" fill="${COLORS.headerMuted}">Best ${formatNumber(player.highestTrophies)} • ${escapeXml(truncate(rank, 20))}</text>`;
}

function compactHeader(
  profile: PlayerProfileView,
  icon: string | null,
  title: string,
  right: string | null,
  height = 112,
): string {
  const player = profile.player;
  const club = profile.currentClub?.name ?? 'No club recorded';
  const rightY = height > 112 ? 54 : 44;
  return `<rect x="0" y="0" width="1200" height="${height}" fill="${COLORS.header}"/>
    <rect x="0" y="${height}" width="1200" height="4" fill="${COLORS.headerLine}"/>
    ${avatarMarkup(icon, player.name, 24, 16, 76)}
    <text x="122" y="42" font-size="28" font-weight="700" fill="${COLORS.headerText}">${escapeXml(truncate(player.name, 26))}</text>
    <text x="124" y="70" font-size="13" fill="${COLORS.headerMuted}">#${escapeXml(player.tag)} • ${escapeXml(truncate(club, 30))}</text>
    <text x="124" y="92" font-size="12" font-weight="700" fill="${COLORS.headerText}">${escapeXml(truncate(title, 54))}</text>
    ${right === null ? '' : `<text x="1172" y="${rightY}" text-anchor="end" font-size="24" font-weight="700" fill="${COLORS.headerText}">${escapeXml(truncate(right, 28))}</text>`}
    ${right === null ? '' : `<text x="1172" y="${rightY + 24}" text-anchor="end" font-size="12" fill="${COLORS.headerMuted}">${escapeXml(truncate(rankedLine(player), 26))}</text>`}`;
}

function totals(profile: PlayerProfileView) {
  const brawlers = profile.brawlers;
  return {
    power11: brawlers.filter((brawler) => brawler.power === 11).length,
    gadgets: brawlers.reduce((total, brawler) => total + (brawler.gadgets ?? 0), 0),
    starPowers: brawlers.reduce((total, brawler) => total + (brawler.starPowers ?? 0), 0),
    gears: brawlers.reduce((total, brawler) => total + (brawler.gears ?? 0), 0),
    hyperCharges: brawlers.reduce((total, brawler) => total + (brawler.hyperCharges ?? 0), 0),
    brawlerCount: profile.stats?.brawlerCount ?? brawlers.length,
    maxedBrawlers: profile.stats?.maxedBrawlers ?? null,
    wins: [profile.player.threeVsThreeVictories, profile.player.soloVictories, profile.player.duoVictories]
      .reduce<number>((total, value) => total + (value ?? 0), 0),
  };
}

function sortedBrawlers(
  source: readonly PlayerBrawler[],
  mode: PlayerCardMode,
  limit: number,
): readonly PlayerBrawler[] {
  const brawlers = [...source];
  switch (mode) {
    case 'rank':
      return brawlers
        .sort((left, right) => (right.rank ?? -1) - (left.rank ?? -1) || right.trophies - left.trophies)
        .slice(0, limit);
    case 'highest':
      return brawlers
        .sort((left, right) => (right.highestTrophies ?? right.trophies) - (left.highestTrophies ?? left.trophies))
        .slice(0, limit);
    default:
      return brawlers.sort((left, right) => right.trophies - left.trophies).slice(0, limit);
  }
}

function brawlerValue(brawler: PlayerBrawler, mode: PlayerCardMode): string {
  if (mode === 'rank') return `Rank ${formatNumber(brawler.rank)}`;
  if (mode === 'highest') return formatNumber(brawler.highestTrophies ?? brawler.trophies);
  return formatNumber(brawler.trophies);
}

function brawlerAccent(brawler: PlayerBrawler, mode: PlayerCardMode): string {
  const trophies = mode === 'highest' ? (brawler.highestTrophies ?? brawler.trophies) : brawler.trophies;
  if (trophies >= 1000) return COLORS.gold;
  if (trophies >= 750) return COLORS.gray;
  if (trophies >= 500) return COLORS.green;
  return COLORS.blue;
}

function brawlerPortrait(
  dataUrl: string | null,
  name: string,
  x: number,
  y: number,
  size: number,
): string {
  if (dataUrl !== null) {
    return `<image href="${dataUrl}" x="${x}" y="${y}" width="${size}" height="${size}" rx="14" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="14" fill="#eef1f5" stroke="${COLORS.border}"/>
    <text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" text-anchor="middle" font-size="${Math.round(size * 0.32)}" font-weight="700" fill="${COLORS.muted}">${escapeXml(initials(name))}</text>`;
}

/** Player Profile preset. */
export async function buildBtProfileImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
): Promise<Buffer> {
  const width = 1200;
  const height = 650;
  const player = profile.player;
  const total = totals(profile);
  const [playerIcon, clubBadge] = await Promise.all([
    assetDataUrl(assets.playerIconUrl, 112),
    assetDataUrl(assets.clubBadgeUrl, 34),
  ]);

  const tiles = [
    ['Trophies', formatNumber(player.trophies), COLORS.blue, `Best ${formatNumber(player.highestTrophies)}`],
    ['Ranked', truncate(rankedLine(player), 18), COLORS.gold, player.rankedElo === null ? null : `${formatNumber(player.rankedElo)} ELO`],
    ['Account level', formatNumber(player.expLevel), COLORS.text, null],
    ['Fame', formatNumber(player.fame), COLORS.green, truncate(player.fameTierName ?? '—', 18)],
    ['3v3 wins', formatNumber(player.threeVsThreeVictories), COLORS.green, null],
    ['Solo wins', formatNumber(player.soloVictories), COLORS.green, null],
    ['Duo wins', formatNumber(player.duoVictories), COLORS.green, null],
    ['Brawlers unlocked', formatNumber(total.brawlerCount), COLORS.blue, null],
    ['Power 11', formatNumber(total.power11), COLORS.gold, null],
    ['Star Powers', formatNumber(total.starPowers), COLORS.gold, null],
    ['Gadgets', formatNumber(total.gadgets), COLORS.gold, null],
    ['Gears', formatNumber(total.gears), COLORS.text, null],
  ] as const;

  const grid = tiles
    .map(([label, value, accent, sub], index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      return statTile(40 + column * 290, 204 + row * 132, 270, 120, label, value, accent, sub);
    })
    .join('');

  const svg = svgDocument(width, height, `
    ${profileHeader(profile, playerIcon, clubBadge, assets.badges)}
    ${grid}
    ${footer('Official Brawl Stars data • static portraits • stored history where shown', 40, 626)}
  `);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Brawler preset: one focused brawler plus a simple ranked grid. */
async function buildBtBrawlerFocusImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
): Promise<Buffer> {
  const width = 1200;
  const height = 1500;
  const playerIcon = await assetDataUrl(assets.playerIconUrl, 76);
  const sorted = sortedBrawlers(options.brawlers ?? profile.brawlers, 'trophies', 17);
  const [focus, ...rest] = sorted;
  const focusUrl = focus === undefined ? null : (assets.allBrawlerPortraitUrls?.[focus.name] ?? null);
  const [focusPortrait, ...restPortraits] = await Promise.all([
    assetDataUrl(focusUrl, 220),
    ...rest.map((brawler) =>
      assetDataUrl(assets.allBrawlerPortraitUrls?.[brawler.name] ?? null, 72),
    ),
  ]);
  const detail = options.brawlerDetail ?? null;
  const accessoryNames = [
    ...(detail?.gadgets ?? []),
    ...(detail?.starPowers ?? []),
    ...(detail?.hyperCharges ?? []),
  ]
    .map((item) => item.name)
    .filter((name): name is string => name !== null && name.trim() !== '')
    .slice(0, 3);

  const focusMarkup = focus === undefined
    ? `${panel(40, 136, 1120, 360)}${sectionTitle(70, 186, 'No brawler data available')}`
    : `${panel(40, 136, 1120, 360)}
      ${brawlerPortrait(focusPortrait, focus.name, 70, 176, 240)}
      ${sectionTitle(350, 190, focus.name, 'Highest trophies brawler from the official profile')}
      <text x="350" y="256" font-size="18" fill="${COLORS.text}">Trophies <tspan font-weight="700">${formatNumber(focus.trophies)}</tspan> • Best <tspan font-weight="700">${formatNumber(focus.highestTrophies ?? focus.trophies)}</tspan></text>
      <text x="350" y="288" font-size="16" fill="${COLORS.muted}">Power ${formatNumber(focus.power)} • Rank ${formatNumber(focus.rank)} • Prestige ${formatNumber(focus.prestigeLevel)}</text>
      <text x="350" y="316" font-size="16" fill="${COLORS.muted}">Win streak ${formatNumber(focus.currentWinStreak)} • Best ${formatNumber(focus.maxWinStreak)}</text>
      ${accessoryNames.length === 0
        ? `<text x="350" y="352" font-size="14" fill="${COLORS.muted}">No accessory names in the official profile detail.</text>`
        : `<text x="350" y="352" font-size="13" fill="${COLORS.muted}">${escapeXml(truncate(accessoryNames.join(' • '), 74))}</text>`}
      <rect x="350" y="382" width="760" height="66" rx="12" fill="#f8f9fb" stroke="${COLORS.border}"/>
      <text x="370" y="424" font-size="14" fill="${COLORS.muted}">Gadgets ${detail?.gadgets.length ?? '—'} • Star Powers ${detail?.starPowers.length ?? '—'} • Hypercharges ${detail?.hyperCharges.length ?? '—'} • Gears ${detail?.gears.length ?? '—'}</text>`;

  const restMarkup = rest
    .map((brawler, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const x = 40 + column * 290;
      const y = 520 + row * 228;
      return `${panel(x, y, 270, 212)}
        ${brawlerPortrait(restPortraits[index] ?? null, brawler.name, x + 16, y + 16, 72)}
        <text x="${x + 104}" y="${y + 40}" font-size="16" font-weight="700" fill="${COLORS.text}">${escapeXml(truncate(brawler.name, 16))}</text>
        <text x="${x + 104}" y="${y + 72}" font-size="20" font-weight="700" fill="${brawlerAccent(brawler, 'trophies')}">${formatNumber(brawler.trophies)}</text>
        <text x="${x + 18}" y="${y + 132}" font-size="13" fill="${COLORS.muted}">Power ${formatNumber(brawler.power)} • Rank ${formatNumber(brawler.rank)}</text>
        <text x="${x + 18}" y="${y + 158}" font-size="12" fill="${COLORS.muted}">Best ${formatNumber(brawler.highestTrophies ?? brawler.trophies)}</text>
        <text x="${x + 18}" y="${y + 184}" font-size="11" fill="${COLORS.faint}">G${brawler.gadgets} • S${brawler.starPowers} • H${brawler.hyperCharges}</text>`;
    })
    .join('');

  const svg = svgDocument(width, height, `
    ${compactHeader(profile, playerIcon, 'Brawler focus', `${formatNumber(profile.player.trophies)} trophies`)}
    ${focusMarkup}
    ${sectionTitle(40, 508, 'Next brawlers')}
    ${restMarkup}
    ${footer('Official Brawl Stars data • static portraits • accessory names only when officially supplied', 40, 1474)}
  `);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Rank / Trophies / Highest presets: a clean four-column brawler grid. */
async function buildBtBrawlerGridImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
  mode: Exclude<PlayerCardMode, 'profile' | 'brawler' | 'season' | 'history'>,
): Promise<Buffer> {
  const width = 1200;
  const height = 1500;
  const playerIcon = await assetDataUrl(assets.playerIconUrl, 76);
  const brawlers = sortedBrawlers(options.brawlers ?? profile.brawlers, mode, 20);
  const portraits = await Promise.all(
    brawlers.map((brawler) => assetDataUrl(assets.allBrawlerPortraitUrls?.[brawler.name] ?? null, 88)),
  );
  const title = mode === 'rank' ? 'Brawler Rank' : mode === 'highest' ? 'Brawler Highest Trophies' : 'Brawler Trophies';

  const cards = brawlers
    .map((brawler, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const x = 40 + column * 290;
      const y = 140 + row * 256;
      const accent = brawlerAccent(brawler, mode);
      return `${panel(x, y, 270, 240)}
        <rect x="${x + 1}" y="${y + 18}" width="5" height="204" rx="3" fill="${accent}"/>
        ${brawlerPortrait(portraits[index] ?? null, brawler.name, x + 22, y + 22, 88)}
        <text x="${x + 124}" y="${y + 48}" font-size="16" font-weight="700" fill="${COLORS.text}">${escapeXml(truncate(brawler.name, 15))}</text>
        <text x="${x + 124}" y="${y + 84}" font-size="22" font-weight="700" fill="${accent}">${escapeXml(brawlerValue(brawler, mode))}</text>
        <text x="${x + 24}" y="${y + 142}" font-size="13" fill="${COLORS.muted}">Power ${formatNumber(brawler.power)} • Rank ${formatNumber(brawler.rank)}</text>
        <text x="${x + 24}" y="${y + 170}" font-size="13" fill="${COLORS.muted}">Best ${formatNumber(brawler.highestTrophies ?? brawler.trophies)}</text>
        <text x="${x + 24}" y="${y + 202}" font-size="11" fill="${COLORS.faint}">Prestige ${formatNumber(brawler.prestigeLevel)} • Streak ${formatNumber(brawler.currentWinStreak)}</text>`;
    })
    .join('');

  const svg = svgDocument(width, height, `
    ${compactHeader(profile, playerIcon, title, `${formatNumber(profile.player.trophies)} trophies`)}
    ${cards}
    ${footer('Official Brawl Stars data • static portraits • sorted by the selected stat', 40, 1474)}
  `);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Season Progress preset with stored mode rates and stored charts. */
export async function buildBtSeasonImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
  charts: BrawlToolsCharts | null,
): Promise<Buffer> {
  const width = 1200;
  const height = 1120;
  const playerIcon = await assetDataUrl(assets.playerIconUrl, 76);
  const player = profile.player;
  const snapshots = options.snapshots ?? [];
  const first = snapshots[0]?.trophies ?? null;
  const latest = snapshots.at(-1)?.trophies ?? null;
  const trophyPush = first === null || latest === null ? null : latest - first;
  const modeStats = options.modeStats ?? [];
  const matches = modeStats.reduce((sum, stat) => sum + stat.matches, 0);
  const victories = modeStats.reduce((sum, stat) => sum + stat.wins, 0);
  const winRate = matches === 0 ? null : (victories / matches) * 100;
  const window = options.seasonWindow;
  const start = window?.start === null || window?.start === undefined ? '—' : formatDate(window.start);
  const end = window?.end === null || window?.end === undefined ? '—' : formatDate(window.end);

  const modeRows = modeStats
    .slice(0, 7)
    .map((stat, index) => {
      const y = 330 + index * 44;
      const rate = stat.winRate === null ? '—' : `${stat.winRate.toFixed(1)}%`;
      const barWidth = stat.winRate === null ? 0 : Math.max(0, Math.min(160, (stat.winRate / 100) * 160));
      return `<text x="64" y="${y + 18}" font-size="14" fill="${COLORS.text}">${escapeXml(truncate(stat.label, 18))}</text>
        <text x="250" y="${y + 18}" text-anchor="end" font-size="12" fill="${COLORS.muted}">${stat.wins}/${stat.matches}</text>
        <rect x="270" y="${y + 8}" width="160" height="12" rx="6" fill="#eef1f5"/>
        <rect x="270" y="${y + 8}" width="${barWidth}" height="12" rx="6" fill="${COLORS.green}"/>
        <text x="438" y="${y + 19}" text-anchor="end" font-size="14" font-weight="700" fill="${COLORS.text}">${escapeXml(rate)}</text>`;
    })
    .join('');

  // Stored charts are 1200x700. Resize to the identical 12:7 ratio so the
  // graphs are never stretched, and give them enough vertical room to read.
  const composites: { input: Buffer; left: number; top: number }[] = [];
  if (charts?.trophyChartPng !== null && charts?.trophyChartPng !== undefined) {
    composites.push({
      input: await sharp(charts.trophyChartPng).resize(600, 350, { fit: 'inside' }).toBuffer(),
      left: 520,
      top: 284,
    });
  }
  if (charts?.activityChartPng !== null && charts?.activityChartPng !== undefined) {
    composites.push({
      input: await sharp(charts.activityChartPng).resize(600, 350, { fit: 'inside' }).toBuffer(),
      left: 520,
      top: 704,
    });
  }

  const profileTotals = totals(profile);
  const summary = [
    summaryRow(64, 736, 'Current rank', rankedLine(player)),
    summaryRow(64, 780, 'Ranked ELO', formatNumber(player.rankedElo)),
    summaryRow(64, 824, 'Highest rank', player.highestSeasonRankedRankName ?? '—'),
    summaryRow(64, 868, '3v3 wins', formatNumber(player.threeVsThreeVictories)),
    summaryRow(64, 912, 'Solo wins', formatNumber(player.soloVictories)),
    summaryRow(64, 956, 'Duo wins', formatNumber(player.duoVictories)),
    summaryRow(64, 1000, 'Brawlers', formatNumber(profileTotals.brawlerCount)),
    summaryRow(64, 1044, 'Power 11', formatNumber(profileTotals.power11)),
  ].join('');

  const svg = svgDocument(width, height, `
    ${compactHeader(profile, playerIcon, `Season Progress • ${start} → ${end}`, `${formatNumber(player.trophies)} trophies`)}
    ${statTile(40, 126, 270, 88, 'Current trophies', formatNumber(player.trophies), COLORS.blue)}
    ${statTile(330, 126, 270, 88, 'Stored push', trophyPush === null ? '—' : `${trophyPush >= 0 ? '+' : ''}${formatNumber(trophyPush)}`, COLORS.green)}
    ${statTile(620, 126, 270, 88, 'Matches played', formatNumber(matches), COLORS.gold)}
    ${statTile(910, 126, 250, 88, 'Win rate', winRate === null ? '—' : `${winRate.toFixed(1)}%`, COLORS.green, player.rankedElo === null ? null : `${formatNumber(player.rankedElo)} ELO`)}

    ${panel(40, 240, 420, 400)}
    ${sectionTitle(62, 286, 'Mode win rates')}
    ${modeRows}
    ${modeStats.length === 0 ? '<text x="64" y="360" font-size="14" fill="#6b7280">No stored battles in this window.</text>' : ''}

    ${panel(40, 660, 420, 400)}
    ${sectionTitle(62, 706, 'Season summary')}
    ${summary}

    ${panel(480, 240, 680, 400)}
    ${sectionTitle(500, 276, 'Player trophies')}
    ${charts?.trophyChartPng == null ? '<text x="500" y="440" font-size="14" fill="#6b7280">No stored trophy snapshots for this guild.</text>' : ''}

    ${panel(480, 660, 680, 400)}
    ${sectionTitle(500, 696, 'Matches played')}
    ${charts?.activityChartPng == null ? '<text x="500" y="860" font-size="14" fill="#6b7280">No stored battles for this guild.</text>' : ''}

    ${footer('Official Brawl Stars data • stored guild history for graphs and mode rates', 40, 1092)}
  `);
  const background = await sharp(Buffer.from(svg)).png().toBuffer();
  if (composites.length === 0) return background;
  return sharp(background).composite(composites).png().toBuffer();
}

/** Player History preset with only the records BrawlHub actually stores. */
export async function buildBtHistoryImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
): Promise<Buffer> {
  const width = 1200;
  const height = 1800;
  const playerIcon = await assetDataUrl(assets.playerIconUrl, 76);
  const summary = options.history;
  const total = totals(profile);
  const events = summary?.events ?? [];
  const mega = summary?.megaPig ?? null;
  const snapshots = [...(options.snapshots ?? [])]
    .filter((point): point is PlayerSnapshotPoint & { readonly trophies: number } => point.trophies !== null)
    .slice(-12);

  const clubRows = events
    .slice(0, 8)
    .map((event, index) => {
      const y = 202 + index * 42;
      return `<rect x="64" y="${y}" width="1072" height="34" rx="9" fill="#f8f9fb"/>
        <text x="82" y="${y + 23}" font-size="12" fill="${COLORS.muted}">${escapeXml(formatDate(event.date))}</text>
        <text x="220" y="${y + 23}" font-size="14" fill="${COLORS.text}">${escapeXml(truncate(event.label, 66))}</text>`;
    })
    .join('');

  const snapshotRows = snapshots
    .map((point, index) => {
      const y = 1120 + index * 46;
      const older = snapshots[index + 1]?.trophies ?? null;
      const delta = older === null ? '—' : `${point.trophies - older >= 0 ? '+' : ''}${formatNumber(point.trophies - older)}`;
      return `<rect x="64" y="${y}" width="1072" height="36" rx="9" fill="#f8f9fb"/>
        <text x="82" y="${y + 24}" font-size="12" fill="${COLORS.muted}">${escapeXml(formatDate(point.date))}</text>
        <text x="240" y="${y + 24}" font-size="14" font-weight="700" fill="${COLORS.text}">${formatNumber(point.trophies)}</text>
        <text x="1118" y="${y + 24}" text-anchor="end" font-size="13" font-weight="700" fill="${point.trophies - (older ?? point.trophies) >= 0 ? COLORS.green : '#d9534f'}">${escapeXml(delta)}</text>`;
    })
    .join('');

  const svg = svgDocument(width, height, `
    ${compactHeader(profile, playerIcon, 'Player History', formatNumber(profile.player.trophies), 116)}

    ${panel(40, 140, 1120, 440)}
    ${sectionTitle(64, 184, 'Club changes', 'Name, icon and unlock dates are not stored by BrawlHub.')}
    ${clubRows}
    ${events.length === 0 ? '<text x="66" y="244" font-size="14" fill="#6b7280">No stored club changes.</text>' : ''}

    ${panel(40, 600, 1120, 168)}
    ${sectionTitle(64, 642, 'Mega Pig')}
    <text x="64" y="688" font-size="16" fill="${COLORS.text}">${mega === null
      ? 'No stored Mega Pig record'
      : `${escapeXml(formatDate(mega.date))} • ${formatNumber(mega.wins)} wins • ${formatNumber(mega.draws)} draws • ${formatNumber(mega.losses)} losses • ${formatNumber(mega.ticketsUsed)} tickets`}</text>

    ${panel(40, 788, 1120, 224)}
    ${sectionTitle(64, 830, 'Current profile')}
    ${statTile(64, 856, 252, 124, 'Trophies', formatNumber(profile.player.trophies), COLORS.blue)}
    ${statTile(332, 856, 252, 124, 'Highest', formatNumber(profile.player.highestTrophies), COLORS.gold)}
    ${statTile(600, 856, 252, 124, 'Brawlers', formatNumber(total.brawlerCount), COLORS.green)}
    ${statTile(868, 856, 252, 124, 'Power 11', formatNumber(total.power11), COLORS.gold)}

    ${panel(40, 1032, 1120, 724)}
    ${sectionTitle(64, 1078, 'Previous push', `${summary?.points ?? 0} stored snapshots in the selected window`)}
    ${snapshotRows}
    ${snapshots.length === 0 ? '<text x="66" y="1140" font-size="14" fill="#6b7280">No stored trophy snapshots.</text>' : ''}

    ${footer('Official Brawl Stars data • stored guild history only', 40, 1780)}
  `);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Dispatch table used by the player card builder. */
export async function buildBrawlToolsImage(
  mode: PlayerCardMode,
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
  charts: BrawlToolsCharts | null,
): Promise<Buffer> {
  switch (mode) {
    case 'brawler':
      return buildBtBrawlerFocusImage(profile, assets, options);
    case 'rank':
    case 'trophies':
    case 'highest':
      return buildBtBrawlerGridImage(profile, assets, options, mode);
    case 'season':
      return buildBtSeasonImage(profile, assets, options, charts);
    case 'history':
      return buildBtHistoryImage(profile, assets, options);
    default:
      return buildBtProfileImage(profile, assets);
  }
}
