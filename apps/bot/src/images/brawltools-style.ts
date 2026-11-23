import sharp from 'sharp';
import type {
  PlayerCardAssets,
  PlayerCardMode,
  PlayerCardOptions,
  PlayerSnapshotPoint,
} from '../players/card.js';
import type { PlayerBrawler, PlayerProfileView } from '../players/types.js';

/**
 * BrawlTools-style image layouts. Every value comes from the official player
 * profile or from stored guild-scoped snapshots/battles. No invented history.
 */

export interface BrawlToolsCharts {
  readonly trophyChartPng: Buffer | null;
  readonly activityChartPng: Buffer | null;
}

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

function defs(): string {
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d0c22"/>
      <stop offset="55%" stop-color="#1a1640"/>
      <stop offset="100%" stop-color="#35216c"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#292353"/>
      <stop offset="100%" stop-color="#171333"/>
    </linearGradient>
  </defs>`;
}

function statTile(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
  color: string,
): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.1"/>
    <text x="${x + 18}" y="${y + 29}" font-size="12" font-weight="700" letter-spacing="1.3" fill="${color}">${escapeXml(label.toUpperCase())}</text>
    <text x="${x + 18}" y="${y + height - 18}" font-size="26" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(value, 22))}</text>`;
}

function section(x: number, y: number, width: number, height: number, title: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.11"/>
    <text x="${x + 22}" y="${y + 34}" font-size="14" font-weight="700" letter-spacing="1.6" fill="#aaa5d6">${escapeXml(title.toUpperCase())}</text>`;
}

function avatarMarkup(dataUrl: string | null, name: string, x: number, y: number, size: number): string {
  const id = `avatarClip${x}${y}`;
  if (dataUrl !== null) {
    return `<defs><clipPath id="${id}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath></defs>
      <image href="${dataUrl}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="#2f2a63" stroke="#8f82ff" stroke-width="4"/>
    <text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" text-anchor="middle" font-size="${Math.round(size * 0.32)}" font-weight="700" fill="#dcd6ff">${escapeXml(initials(name))}</text>`;
}

function clubMarkup(dataUrl: string | null, x: number, y: number, size: number): string {
  const id = `clubClip${x}${y}`;
  if (dataUrl !== null) {
    return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.24)}"/></clipPath></defs>
      <image href="${dataUrl}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.24)}" fill="#2f2a63" stroke="#8f82ff" stroke-width="3"/>
    <text x="${x + size / 2}" y="${y + size * 0.62}" text-anchor="middle" font-size="${Math.round(size * 0.34)}" font-weight="700" fill="#dcd6ff">BH</text>`;
}

function badgeLine(badges: readonly string[] | undefined, x: number, y: number): string {
  const labels = (badges ?? []).map((badge) => badge.trim().toUpperCase()).filter((badge) => badge.length > 0);
  if (labels.length === 0) return '';
  return `<text x="${x}" y="${y}" font-size="12" font-weight="700" letter-spacing="1.6" fill="#7de2a0">${escapeXml(labels.slice(0, 3).join(' • '))}</text>`;
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
  profile: PlayerProfileView,
  mode: PlayerCardMode,
  limit: number,
): readonly PlayerBrawler[] {
  const brawlers = [...profile.brawlers];
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
  if (mode === 'rank') return `RANK ${formatNumber(brawler.rank)}`;
  if (mode === 'highest') return `${formatNumber(brawler.highestTrophies ?? brawler.trophies)} BEST`;
  return `${formatNumber(brawler.trophies)} NOW`;
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
    assetDataUrl(assets.playerIconUrl, 176),
    assetDataUrl(assets.clubBadgeUrl, 54),
  ]);
  const ranked = player.rankedRankName ?? player.highestSeasonRankedRankName ?? '—';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs()}
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="1130" cy="20" r="230" fill="#9a7dff" fill-opacity="0.12"/>
  <circle cx="1080" cy="640" r="190" fill="#46d6ff" fill-opacity="0.06"/>
  ${avatarMarkup(playerIcon, player.name, 52, 74, 172)}
  <text x="260" y="110" font-size="42" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(player.name, 24))}</text>
  <text x="262" y="146" font-size="20" fill="#aaa5d6">#${escapeXml(player.tag)}</text>
  ${badgeLine(assets.badges, 262, 174)}
  ${clubMarkup(clubBadge, 262, 190, 50)}
  <text x="328" y="214" font-size="20" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(profile.currentClub?.name ?? 'No club recorded', 26))}</text>
  <text x="328" y="238" font-size="14" fill="#aaa5d6">${escapeXml(player.fameTierName ?? ranked)}</text>
  <text x="1148" y="104" text-anchor="end" font-size="13" letter-spacing="1.6" fill="#aaa5d6">TROPHIES</text>
  <text x="1148" y="158" text-anchor="end" font-size="50" font-weight="700" fill="#46d6ff">${formatNumber(player.trophies)}</text>
  <text x="1148" y="190" text-anchor="end" font-size="15" fill="#ffd166">Highest ${formatNumber(player.highestTrophies)} • ${escapeXml(ranked)}</text>
  ${statTile(52, 268, 354, 86, 'Trophies', formatNumber(player.trophies), '#46d6ff')}
  ${statTile(423, 268, 354, 86, 'Highest', formatNumber(player.highestTrophies), '#ffd166')}
  ${statTile(794, 268, 354, 86, 'Account level', formatNumber(player.expLevel), '#8f82ff')}
  ${statTile(52, 370, 354, 86, '3v3 wins', formatNumber(player.threeVsThreeVictories), '#7de2a0')}
  ${statTile(423, 370, 354, 86, 'Solo wins', formatNumber(player.soloVictories), '#ff8fab')}
  ${statTile(794, 370, 354, 86, 'Duo wins', formatNumber(player.duoVictories), '#c58cff')}
  ${statTile(52, 472, 354, 86, 'Brawlers', formatNumber(total.brawlerCount), '#46d6ff')}
  ${statTile(423, 472, 354, 86, 'Star Powers', formatNumber(total.starPowers), '#8f82ff')}
  ${statTile(794, 472, 354, 86, 'Gadgets', formatNumber(total.gadgets), '#ffd166')}
  <text x="52" y="592" font-size="13" fill="#cfc9ff">Fame ${formatNumber(player.fame)} • Prestige ${formatNumber(player.totalPrestigeLevel)} • Power 11 ${total.power11} • Maxed ${formatNumber(total.maxedBrawlers)} • Gears ${total.gears} • Hypercharges ${total.hyperCharges} • Victories ${formatNumber(total.wins)}</text>
  <text x="52" y="620" font-size="12" fill="#8e88bd">Official Brawl Stars data • Static BrawlAPI assets • No invented values</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Brawler/Rank/Trophies/Highest presets: a dense BrawlTools-style grid. */
export async function buildBtBrawlerImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
  mode: PlayerCardMode,
): Promise<Buffer> {
  const width = 1200;
  const height = 1500;
  const player = profile.player;
  const total = totals(profile);
  const brawlers = sortedBrawlers(profile, mode, 40);
  const portraits = await Promise.all(
    brawlers.map((brawler) => assetDataUrl(assets.allBrawlerPortraitUrls?.[brawler.name] ?? null, 60)),
  );
  const detail = options.brawlerDetail;
  const focusNames = [
    ...(detail?.gadgets ?? []),
    ...(detail?.starPowers ?? []),
    ...(detail?.hyperCharges ?? []),
  ]
    .map((item) => item.name)
    .filter((name): name is string => name !== null && name.trim() !== '')
    .slice(0, 3);
  const focusLine = detail === undefined || detail === null
    ? `View ${mode.toUpperCase()} • top 40 brawlers from official profile data`
    : `Focus ${detail.name}${focusNames.length === 0 ? '' : ` • ${focusNames.map((name) => truncate(name, 20)).join(' • ')}`}`;

  const cards = brawlers
    .map((brawler, index) => {
      const column = index % 5;
      const row = Math.floor(index / 5);
      const x = 40 + column * 228;
      const y = 186 + row * 150;
      const portrait = portraits[index];
      const highlighted = detail?.name === brawler.name;
      const portraitMarkup =
        portrait === null
          ? `<rect x="${x + 10}" y="${y + 10}" width="60" height="60" rx="15" fill="#2f2a63" stroke="#8f82ff" stroke-width="2"/>
             <text x="${x + 40}" y="${y + 48}" text-anchor="middle" font-size="19" font-weight="700" fill="#dcd6ff">${escapeXml(initials(brawler.name))}</text>`
          : `<image href="${portrait}" x="${x + 10}" y="${y + 10}" width="60" height="60" rx="15" preserveAspectRatio="xMidYMid slice"/>`;
      const accessoryCount = `G${brawler.gadgets ?? '—'} • S${brawler.starPowers ?? '—'} • H${brawler.hyperCharges ?? '—'}`;
      return `<rect x="${x}" y="${y}" width="216" height="138" rx="16" fill="#ffffff" fill-opacity="${index % 2 === 0 ? '0.055' : '0.03'}" stroke="${highlighted ? '#7de2a0' : '#ffffff'}" stroke-opacity="${highlighted ? '0.8' : '0.09'}" stroke-width="${highlighted ? '2' : '1'}"/>
        ${portraitMarkup}
        <text x="${x + 80}" y="${y + 30}" font-size="16" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(brawler.name, 18))}</text>
        <text x="${x + 80}" y="${y + 52}" font-size="14" font-weight="700" fill="#46d6ff">${escapeXml(brawlerValue(brawler, mode))}</text>
        <text x="${x + 80}" y="${y + 73}" font-size="12" fill="#ffd166">P${brawler.power ?? '—'} • R${brawler.rank ?? '—'}</text>
        <text x="${x + 12}" y="${y + 112}" font-size="11" fill="#aaa5d6">${escapeXml(accessoryCount)}</text>
        <text x="${x + 12}" y="${y + 128}" font-size="11" fill="#8e88bd">Best ${formatNumber(brawler.highestTrophies ?? brawler.trophies)}</text>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs()}
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="1160" cy="20" r="230" fill="#9a7dff" fill-opacity="0.1"/>
  <text x="40" y="58" font-size="34" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(player.name, 26))}</text>
  <text x="40" y="90" font-size="16" fill="#aaa5d6">#${escapeXml(player.tag)} • ${escapeXml(truncate(profile.currentClub?.name ?? 'No club recorded', 26))}</text>
  <text x="40" y="120" font-size="13" fill="#7de2a0">${escapeXml(truncate(focusLine, 100))}</text>
  <text x="1160" y="58" text-anchor="end" font-size="24" font-weight="700" fill="#46d6ff">${formatNumber(player.trophies)}</text>
  <text x="1160" y="88" text-anchor="end" font-size="14" fill="#cfc9ff">Peak ${formatNumber(player.highestTrophies)} • Victories ${formatNumber(total.wins)} • ${escapeXml(rankedLine(player))}</text>
  <text x="1160" y="116" text-anchor="end" font-size="13" fill="#aaa5d6">Brawlers ${formatNumber(total.brawlerCount)} • P11 ${total.power11} • Star Powers ${total.starPowers} • Gadgets ${total.gadgets} • Gears ${total.gears} • Hypercharges ${total.hyperCharges}</text>
  ${cards}
  <text x="40" y="1478" font-size="12" fill="#8e88bd">Official Brawl Stars data • Static BrawlAPI assets • ${escapeXml(mode.toUpperCase())} view • no invented accessory names</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function rankedLine(player: PlayerProfileView['player']): string {
  return player.rankedRankName ?? player.highestSeasonRankedRankName ?? '—';
}

/** Season Progress preset with mode win rates and stored graphs when available. */
export async function buildBtSeasonImage(
  profile: PlayerProfileView,
  options: PlayerCardOptions,
  charts: BrawlToolsCharts | null,
): Promise<Buffer> {
  const width = 1200;
  const height = 720;
  const player = profile.player;
  const snapshots = options.snapshots ?? [];
  const first = snapshots[0]?.trophies ?? null;
  const latest = snapshots.at(-1)?.trophies ?? null;
  const trophyPush = first === null || latest === null ? null : latest - first;
  const modeStats = options.modeStats ?? [];
  const total = totals(profile);
  const window = options.seasonWindow;
  const start = window?.start === null || window?.start === undefined ? '—' : formatDate(window.start);
  const end = window?.end === null || window?.end === undefined ? '—' : formatDate(window.end);

  const modeRows = modeStats
    .slice(0, 7)
    .map((stat, index) => {
      const y = 422 + index * 34;
      const rate = stat.winRate === null ? '—' : `${stat.winRate.toFixed(1)}%`;
      return `<rect x="58" y="${y}" width="384" height="28" rx="9" fill="#ffffff" fill-opacity="${index % 2 === 0 ? '0.05' : '0.025'}"/>
        <text x="70" y="${y + 19}" font-size="13" fill="#f7f6ff">${escapeXml(truncate(stat.label, 18))}</text>
        <text x="326" y="${y + 19}" text-anchor="end" font-size="12" fill="#aaa5d6">${stat.wins}/${stat.matches}</text>
        <text x="430" y="${y + 19}" text-anchor="end" font-size="13" font-weight="700" fill="#7de2a0">${escapeXml(rate)}</text>`;
    })
    .join('');
  const emptyModes = modeStats.length === 0
    ? `<text x="70" y="452" font-size="13" fill="#aaa5d6">No stored battles in this window.</text>`
    : '';

  const composites: { input: Buffer; left: number; top: number }[] = [];
  if (charts?.trophyChartPng !== null && charts?.trophyChartPng !== undefined) {
    composites.push({
      input: await sharp(charts.trophyChartPng).resize(652, 240, { fit: 'fill' }).toBuffer(),
      left: 494,
      top: 150,
    });
  }
  if (charts?.activityChartPng !== null && charts?.activityChartPng !== undefined) {
    composites.push({
      input: await sharp(charts.activityChartPng).resize(652, 240, { fit: 'fill' }).toBuffer(),
      left: 494,
      top: 434,
    });
  }
  const trophyPlaceholder = charts?.trophyChartPng == null
    ? `<text x="510" y="270" font-size="14" fill="#aaa5d6">No stored trophy snapshots for this guild.</text>`
    : '';
  const activityPlaceholder = charts?.activityChartPng == null
    ? `<text x="510" y="554" font-size="14" fill="#aaa5d6">No stored battles for this guild.</text>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs()}
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="1160" cy="20" r="230" fill="#9a7dff" fill-opacity="0.11"/>
  <text x="40" y="56" font-size="32" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(player.name, 24))} • Season Progress</text>
  <text x="40" y="86" font-size="14" fill="#aaa5d6">#${escapeXml(player.tag)} • ${escapeXml(rankedLine(player))} • ${formatNumber(player.fame)} fame • ${escapeXml(start)} → ${escapeXml(end)}</text>
  ${statTile(40, 112, 202, 100, 'Trophies', formatNumber(player.trophies), '#46d6ff')}
  ${statTile(260, 112, 202, 100, 'Stored push', trophyPush === null ? '—' : `${trophyPush >= 0 ? '+' : ''}${formatNumber(trophyPush)}`, '#7de2a0')}
  ${statTile(40, 228, 202, 100, 'Prestige level', formatNumber(player.totalPrestigeLevel), '#8f82ff')}
  ${statTile(260, 228, 202, 100, 'Matches played', formatNumber(modeStats.reduce((sum, stat) => sum + stat.matches, 0)), '#ffd166')}
  ${section(40, 356, 420, 318, 'Mode win rates')}
  ${modeRows}
  ${emptyModes}
  ${section(480, 112, 680, 300, 'Player trophies')}
  ${trophyPlaceholder}
  ${section(480, 414, 680, 300, 'Matches played')}
  ${activityPlaceholder}
  <text x="40" y="700" font-size="12" fill="#8e88bd">Stored official data only • ${formatNumber(total.wins)} recorded victories • graphs omitted when no guild history is available</text>
</svg>`;
  const background = await sharp(Buffer.from(svg)).png().toBuffer();
  if (composites.length === 0) return background;
  return sharp(background).composite(composites).png().toBuffer();
}

/** Player History preset with the stored sections used by BrawlTools. */
export async function buildBtHistoryImage(
  profile: PlayerProfileView,
  options: PlayerCardOptions,
): Promise<Buffer> {
  const width = 1200;
  const height = 1800;
  const summary = options.history;
  const snapshots = [...(options.snapshots ?? [])]
    .filter((point): point is PlayerSnapshotPoint & { readonly trophies: number } => point.trophies !== null)
    .slice(-10)
    .reverse();
  const events = summary?.events ?? [];
  const mega = summary?.megaPig ?? null;
  const total = totals(profile);

  const clubRows = events
    .slice(0, 8)
    .map((event, index) => {
      const y = 170 + index * 36;
      return `<rect x="62" y="${y}" width="1076" height="30" rx="9" fill="#ffffff" fill-opacity="${index % 2 === 0 ? '0.05' : '0.025'}"/>
        <text x="76" y="${y + 21}" font-size="13" fill="#cfc9ff">${escapeXml(formatDate(event.date))}</text>
        <text x="220" y="${y + 21}" font-size="14" fill="#f7f6ff">${escapeXml(truncate(event.label, 62))}</text>`;
    })
    .join('');

  const snapshotRows = snapshots
    .map((point, index) => {
      const y = 1280 + index * 40;
      const older = snapshots[index + 1]?.trophies ?? null;
      const delta = older === null ? '—' : `${point.trophies - older >= 0 ? '+' : ''}${formatNumber(point.trophies - older)}`;
      return `<rect x="62" y="${y}" width="1076" height="32" rx="9" fill="#ffffff" fill-opacity="${index % 2 === 0 ? '0.05' : '0.025'}"/>
        <text x="76" y="${y + 22}" font-size="13" fill="#cfc9ff">${escapeXml(formatDate(point.date))}</text>
        <text x="240" y="${y + 22}" font-size="14" fill="#f7f6ff">${formatNumber(point.trophies)}</text>
        <text x="1110" y="${y + 22}" text-anchor="end" font-size="13" font-weight="700" fill="#7de2a0">${escapeXml(delta)}</text>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs()}
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="1160" cy="20" r="230" fill="#9a7dff" fill-opacity="0.1"/>
  <text x="40" y="60" font-size="34" font-weight="700" fill="#f7f6ff">History from ${escapeXml(truncate(profile.player.name, 26))}</text>
  <text x="40" y="92" font-size="15" fill="#aaa5d6">#${escapeXml(profile.player.tag)} • stored official records only</text>
  ${section(40, 124, 1120, 360, 'Club history')}
  ${clubRows}
  ${events.length === 0 ? '<text x="76" y="200" font-size="14" fill="#aaa5d6">No stored club changes.</text>' : ''}
  ${section(40, 504, 1120, 170, 'Mega Pig')}
  <text x="76" y="564" font-size="16" fill="#f7f6ff">${mega === null ? 'No stored Mega Pig record' : `${escapeXml(formatDate(mega.date))} • ${formatNumber(mega.wins)} wins • ${formatNumber(mega.draws)} draws • ${formatNumber(mega.losses)} losses • ${formatNumber(mega.ticketsUsed)} tickets`}</text>
  <text x="76" y="600" font-size="13" fill="#8e88bd">Only the stored Mega Pig summary is shown; no unrecorded results are inferred.</text>
  ${section(40, 694, 1120, 150, 'Name / icon / ranked records')}
  <text x="76" y="754" font-size="15" fill="#aaa5d6">Not stored by BrawlHub. Current ranked: ${escapeXml(rankedLine(profile.player))}.</text>
  ${section(40, 864, 1120, 150, 'Brawler / Star Power / Gadget unlocks')}
  <text x="76" y="924" font-size="15" fill="#aaa5d6">Unlock dates are not exposed by the current official Brawl Stars API.</text>
  ${section(40, 1034, 1120, 150, 'Hypercharges / buffies')}
  <text x="76" y="1094" font-size="15" fill="#aaa5d6">Hypercharges owned ${total.hyperCharges} • Buffie records are not stored by BrawlHub.</text>
  ${section(40, 1204, 1120, 540, 'Previous push')}
  ${snapshotRows}
  ${snapshots.length === 0 ? '<text x="76" y="1300" font-size="14" fill="#aaa5d6">No stored trophy snapshots.</text>' : ''}
  <text x="40" y="1780" font-size="12" fill="#8e88bd">Official Brawl Stars data • Static BrawlAPI assets • No invented historical records</text>
</svg>`;
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
    case 'rank':
    case 'trophies':
    case 'highest':
      return buildBtBrawlerImage(profile, assets, options, mode);
    case 'season':
      return buildBtSeasonImage(profile, options, charts);
    case 'history':
      return buildBtHistoryImage(profile, options);
    default:
      return buildBtProfileImage(profile, assets);
  }
}
