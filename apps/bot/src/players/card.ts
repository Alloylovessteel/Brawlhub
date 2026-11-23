import sharp from 'sharp';
import type { PlayerBrawler, PlayerBrawlerDetail, PlayerProfileView } from './types';

/**
 * Static image assets passed in by the command layer. URLs come only from the
 * BrawlAPI static metadata resolver; every value shown on the card comes from
 * the official Brawl Stars player profile in `PlayerProfileView`.
 */
export interface PlayerCardAssets {
  readonly playerIconUrl?: string | null;
  readonly clubBadgeUrl?: string | null;
  readonly brawlerPortraitUrls?: readonly (string | null | undefined)[];
  /** Portrait URLs keyed by brawler name, used by grid/rank image modes. */
  readonly allBrawlerPortraitUrls?: Readonly<Record<string, string | null | undefined>>;
  readonly badges?: readonly string[];
}

export const PLAYER_CARD_MODES = [
  'profile',
  'brawler',
  'rank',
  'trophies',
  'highest',
  'season',
  'history',
] as const;

export type PlayerCardMode = (typeof PLAYER_CARD_MODES)[number];

export interface PlayerSeasonWindow {
  readonly start: string | null;
  readonly end: string | null;
}

export interface PlayerHistoryEvent {
  readonly type: 'join' | 'leave' | 'transfer';
  readonly label: string;
  readonly date: string | null;
}

export interface PlayerHistoryMegaPig {
  readonly date: string | null;
  readonly wins: number | null;
  readonly draws: number | null;
  readonly losses: number | null;
  readonly ticketsUsed: number | null;
}

export interface PlayerHistorySummary {
  readonly points: number;
  readonly firstAt: string | null;
  readonly latestAt: string | null;
  readonly firstTrophies: number | null;
  readonly latestTrophies: number | null;
  readonly clubChanges: number | null;
  readonly nameChanges: number | null;
  readonly events: readonly PlayerHistoryEvent[];
  readonly megaPig: PlayerHistoryMegaPig | null;
}

export interface PlayerCardOptions {
  readonly mode?: PlayerCardMode;
  readonly brawlerName?: string | null;
  readonly brawlerDetail?: PlayerBrawlerDetail | null;
  readonly seasonWindow?: PlayerSeasonWindow;
  readonly history?: PlayerHistorySummary | null;
}

const WIDTH = 1200;
const HEIGHT = 720;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_000_000;
const ASSET_TIMEOUT_MS = 5_000;
const SUPPORTED_IMAGE_TYPE = /^image\/(?:png|jpeg|webp|gif)$/i;

const BRAWLER_X = [70, 420, 770] as const;
const STAT_X = [70, 420, 770] as const;

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

function formatNumber(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('en-US').format(value);
}

function formatDate(value: string | null): string {
  if (value === null) return 'No timestamp';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'No timestamp';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function formatRole(role: string | null): string {
  if (role === null || role.trim() === '') return 'No role recorded';
  const normalized = role.replaceAll('_', ' ').trim();
  if (normalized.toLowerCase() === 'vice president') return 'Vice President';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return 'BS';
  if (parts.length === 1) return Array.from(parts[0] ?? 'BS').slice(0, 2).join('').toUpperCase();
  return `${Array.from(parts[0] ?? '')[0] ?? ''}${Array.from(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
}

/** Download and normalise a static asset to a safe, fixed-size PNG data URI. */
async function assetDataUrl(url: string | null | undefined, size: number): Promise<string | null> {
  if (url === null || url === undefined || url.trim() === '') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;

    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
      headers: { 'user-agent': 'BrawlHub Discord bot' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!SUPPORTED_IMAGE_TYPE.test(contentType)) return null;

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ASSET_BYTES) return null;

    const normalized = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer();
    return `data:image/png;base64,${normalized.toString('base64')}`;
  } catch {
    return null;
  }
}

function avatarMarkup(dataUrl: string | null, name: string): string {
  if (dataUrl !== null) {
    return `<image href="${dataUrl}" x="66" y="150" width="156" height="156" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<circle cx="144" cy="228" r="78" fill="#2f2a63" stroke="#8f82ff" stroke-width="4"/>
    <text x="144" y="245" text-anchor="middle" font-size="46" font-weight="700" fill="#dcd6ff">${escapeXml(initials(name))}</text>`;
}

function clubMarkup(dataUrl: string | null): string {
  if (dataUrl !== null) {
    return `<image href="${dataUrl}" x="786" y="154" width="58" height="58" rx="14" clip-path="url(#clubClip)" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<rect x="786" y="154" width="58" height="58" rx="14" fill="#2f2a63" stroke="#8f82ff" stroke-width="3"/>
    <text x="815" y="191" text-anchor="middle" font-size="22" font-weight="700" fill="#dcd6ff">BH</text>`;
}

function badgeMarkup(badges: readonly string[], startX: number, y: number): string {
  let cursor = startX;
  return badges
    .map((badge) => badge.trim().toUpperCase())
    .filter((badge) => badge.length > 0)
    .slice(0, 3)
    .map((badge) => {
      const label = escapeXml(truncate(badge, 14));
      const width = Math.max(86, Array.from(label).length * 10 + 26);
      const markup = `<rect x="${cursor}" y="${y}" width="${width}" height="30" rx="15" fill="#8f82ff" fill-opacity="0.22" stroke="#8f82ff" stroke-opacity="0.65"/>
        <text x="${cursor + width / 2}" y="${y + 20}" text-anchor="middle" font-size="14" font-weight="700" letter-spacing="1.2" fill="#dcd6ff">${label}</text>`;
      cursor += width + 10;
      return markup;
    })
    .join('');
}

function statMarkup(x: number, y: number, label: string, value: string, accent: string): string {
  return `<rect x="${x}" y="${y}" width="310" height="84" rx="18" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.09"/>
    <text x="${x + 22}" y="${y + 31}" font-size="14" font-weight="700" letter-spacing="1.6" fill="${accent}">${escapeXml(label.toUpperCase())}</text>
    <text x="${x + 22}" y="${y + 65}" font-size="29" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(value, 18))}</text>`;
}

/** Brawlers featured on the card, highest trophies first. */
export function selectTopBrawlers(profile: PlayerProfileView): readonly PlayerBrawler[] {
  return [...profile.brawlers]
    .sort((left, right) => right.trophies - left.trophies)
    .slice(0, 3);
}

function brawlerMarkup(
  x: number,
  y: number,
  index: number,
  brawler: PlayerBrawler | undefined,
  portrait: string | null,
): string {
  const name = brawler === undefined ? 'No brawler recorded' : brawler.name;
  const trophies = brawler === undefined ? '—' : formatNumber(brawler.trophies);
  const portraitMarkup =
    portrait === null
      ? `<rect x="${x + 14}" y="${y + 12}" width="56" height="56" rx="14" fill="#2f2a63" stroke="#8f82ff" stroke-width="3"/>
         <text x="${x + 42}" y="${y + 49}" text-anchor="middle" font-size="20" font-weight="700" fill="#dcd6ff">${escapeXml(initials(name))}</text>`
      : `<image href="${portrait}" x="${x + 14}" y="${y + 12}" width="56" height="56" clip-path="url(#brawlerClip${index})" preserveAspectRatio="xMidYMid slice"/>`;

  return `<rect x="${x}" y="${y}" width="310" height="80" rx="18" fill="#ffffff" fill-opacity="0.045" stroke="#ffffff" stroke-opacity="0.08"/>
    ${portraitMarkup}
    <text x="${x + 84}" y="${y + 35}" font-size="19" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(name, 20))}</text>
    <text x="${x + 84}" y="${y + 59}" font-size="15" fill="#aaa5d6">${trophies} trophies</text>`;
}

function modeHeading(mode: PlayerCardMode): string {
  switch (mode) {
    case 'brawler': return 'BRAWLER FOCUS';
    case 'rank': return 'BRAWLER RANKS';
    case 'trophies': return 'BRAWLER TROPHIES • CURRENT';
    case 'highest': return 'BRAWLER TROPHIES • HIGHEST';
    case 'season': return 'SEASON SNAPSHOT';
    case 'history': return 'PLAYER HISTORY';
    default: return 'TOP BRAWLERS';
  }
}

function sortedModeBrawlers(
  profile: PlayerProfileView,
  mode: PlayerCardMode,
): readonly PlayerBrawler[] {
  const brawlers = [...profile.brawlers];
  switch (mode) {
    case 'highest':
      return brawlers.sort(
        (left, right) => (right.highestTrophies ?? right.trophies ?? 0) - (left.highestTrophies ?? left.trophies ?? 0),
      );
    case 'rank':
      return brawlers.sort((left, right) => {
        const leftRank = left.rank ?? -1;
        const rightRank = right.rank ?? -1;
        return rightRank - leftRank || right.trophies - left.trophies;
      });
    default:
      return brawlers.sort((left, right) => right.trophies - left.trophies);
  }
}

function focusBrawler(
  profile: PlayerProfileView,
  options: PlayerCardOptions,
): PlayerBrawler | undefined {
  const wanted = options.brawlerName?.trim().toLowerCase();
  if (wanted !== undefined && wanted !== '') {
    const match = profile.brawlers.find((brawler) => brawler.name.toLowerCase() === wanted);
    if (match !== undefined) return match;
  }
  return sortedModeBrawlers(profile, 'trophies')[0];
}

function brawlerPortraitDataUrl(
  name: string,
  assets: PlayerCardAssets,
): Promise<string | null> {
  return assetDataUrl(assets.allBrawlerPortraitUrls?.[name] ?? null, 64);
}

function gridMarkup(
  brawlers: readonly PlayerBrawler[],
  portraits: readonly (string | null)[],
  mode: PlayerCardMode,
): string {
  return brawlers
    .map((brawler, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const x = 64 + column * 272;
      const y = 354 + row * 48;
      const value =
        mode === 'highest'
          ? formatNumber(brawler.highestTrophies ?? brawler.trophies ?? null)
          : mode === 'rank'
            ? brawler.rank === null ? '—' : `R${brawler.rank}`
            : formatNumber(brawler.trophies ?? null);
      const badge =
        mode === 'rank'
          ? `P${brawler.power ?? '—'}`
          : mode === 'highest'
            ? 'BEST'
            : mode === 'trophies'
              ? 'NOW'
              : '';
      const portrait = portraits[index] ?? null;
      const portraitMarkup =
        portrait === null
          ? `<rect width="34" height="34" rx="9" fill="#2f2a63" stroke="#8f82ff" stroke-width="2"/>
             <text x="17" y="23" text-anchor="middle" font-size="12" font-weight="700" fill="#dcd6ff">${escapeXml(initials(brawler.name))}</text>`
          : `<image href="${portrait}" width="34" height="34" preserveAspectRatio="xMidYMid slice"/>`;
      return `<g transform="translate(${x} ${y})">
        <rect width="262" height="42" rx="12" fill="#ffffff" fill-opacity="${index % 2 === 0 ? '0.05' : '0.025'}" stroke="#ffffff" stroke-opacity="0.07"/>
        <g transform="translate(7 4)" clip-path="url(#modeClip${index})">${portraitMarkup}</g>
        <text x="48" y="18" font-size="14" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(brawler.name, 18))}</text>
        <text x="48" y="34" font-size="13" fill="#cfc9ff">${escapeXml(value)}</text>
        <text x="252" y="26" text-anchor="end" font-size="11" font-weight="700" letter-spacing="0.8" fill="#8f82ff">${escapeXml(badge)}</text>
      </g>`;
    })
    .join('');
}

function pill(x: number, y: number, label: string, value: string, color: string): string {
  const width = Math.max(126, Array.from(label).length * 8 + Array.from(value).length * 8 + 34);
  return `<rect x="${x}" y="${y}" width="${width}" height="34" rx="17" fill="#ffffff" fill-opacity="0.055" stroke="${color}" stroke-opacity="0.55"/>
    <text x="${x + 14}" y="${y + 22}" font-size="11" letter-spacing="1" fill="#aaa5d6">${escapeXml(label)}</text>
    <text x="${x + width - 14}" y="${y + 22}" text-anchor="end" font-size="15" font-weight="700" fill="${color}">${escapeXml(value)}</text>`;
}

function focusMarkup(
  brawler: PlayerBrawler | undefined,
  portrait: string | null,
  detail: PlayerBrawlerDetail | null | undefined,
): string {
  if (brawler === undefined) {
    return `<text x="64" y="400" font-size="24" fill="#aaa5d6">No brawler data available for this player.</text>`;
  }
  const portraitMarkup =
    portrait === null
      ? `<rect width="160" height="160" rx="30" fill="#2f2a63" stroke="#8f82ff" stroke-width="4"/>
         <text x="80" y="102" text-anchor="middle" font-size="48" font-weight="700" fill="#dcd6ff">${escapeXml(initials(brawler.name))}</text>`
      : `<image href="${portrait}" width="160" height="160" preserveAspectRatio="xMidYMid slice"/>`;
  const chips = [
    pill(270, 452, 'POWER', formatNumber(brawler.power ?? null), '#8f82ff'),
    pill(406, 452, 'RANK', brawler.rank === null ? '—' : `R${brawler.rank}`, '#ff8fab'),
    pill(542, 452, 'GEARS', detail?.gears.length === undefined ? formatNumber(brawler.gears ?? null) : String(detail.gears.length), '#7de2a0'),
  ].join('');

  const names = (items: readonly { readonly name: string | null }[] | undefined, fallback: number | null): string => {
    const labels = (items ?? []).flatMap((item) =>
      item.name === null || item.name === undefined || item.name.trim() === '' ? [] : [item.name],
    );
    if (labels.length > 0) return labels.slice(0, 2).map((label) => escapeXml(truncate(label, 18))).join(' • ');
    return formatNumber(fallback);
  };
  const accessoryLines = `
    <text x="270" y="524" font-size="14" fill="#cfc9ff">Gadgets: ${names(detail?.gadgets, brawler.gadgets ?? null)}</text>
    <text x="270" y="550" font-size="14" fill="#cfc9ff">Star Powers: ${names(detail?.starPowers, brawler.starPowers ?? null)}</text>
    <text x="270" y="576" font-size="14" fill="#cfc9ff">Hypercharge: ${names(detail?.hyperCharges, brawler.hyperCharges ?? null)}</text>`;

  return `<g transform="translate(76 360)" clip-path="url(#focusClip)">${portraitMarkup}</g>
    <text x="270" y="396" font-size="40" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(brawler.name, 22))}</text>
    <text x="270" y="430" font-size="20" fill="#46d6ff">${formatNumber(brawler.trophies ?? null)} trophies</text>
    ${chips}
    ${accessoryLines}
    <text x="76" y="618" font-size="13" fill="#8e88bd">Highest ${formatNumber(brawler.highestTrophies ?? brawler.trophies ?? null)} • Best streak ${formatNumber(brawler.maxWinStreak ?? null)} • Official accessory names</text>`;
}

function seasonMarkup(
  profile: PlayerProfileView,
  window: PlayerSeasonWindow | undefined,
): string {
  const player = profile.player;
  const wins = [player.threeVsThreeVictories, player.soloVictories, player.duoVictories].reduce<number>(
    (total, value) => total + (value ?? 0),
    0,
  );
  const tiles = [
    ['CURRENT TROPHIES', formatNumber(player.trophies), '#46d6ff'],
    ['HIGHEST TROPHIES', formatNumber(player.highestTrophies), '#ffd166'],
    ['RANKED', player.rankedRankName ?? player.highestSeasonRankedRankName ?? '—', '#ff8fab'],
    ['FAME', formatNumber(player.fame), '#8f82ff'],
    ['VICTORIES', formatNumber(wins), '#7de2a0'],
    ['BRAWLERS', formatNumber(profile.stats?.brawlerCount ?? profile.brawlers.length), '#c58cff'],
  ] as const;
  const markup = tiles
    .map(([label, value, color], index) => {
      const x = 64 + (index % 3) * 360;
      const y = 350 + Math.floor(index / 3) * 118;
      return `<rect x="${x}" y="${y}" width="340" height="98" rx="18" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.09"/>
        <text x="${x + 20}" y="${y + 32}" font-size="12" font-weight="700" letter-spacing="1.4" fill="${color}">${escapeXml(label)}</text>
        <text x="${x + 20}" y="${y + 70}" font-size="26" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(value, 20))}</text>`;
    })
    .join('');
  const start = window?.start === null || window?.start === undefined ? 'not configured' : formatDate(window.start);
  const end = window?.end === null || window?.end === undefined ? 'not configured' : formatDate(window.end);
  return `${markup}
    <text x="64" y="616" font-size="14" fill="#aaa5d6">Season window: ${escapeXml(start)} → ${escapeXml(end)}</text>
    <text x="64" y="640" font-size="13" fill="#8e88bd">Current official values only • no invented season deltas</text>`;
}

function historyMarkup(summary: PlayerHistorySummary | null | undefined): string {
  if (summary === null || summary === undefined) {
    return `<text x="64" y="400" font-size="24" fill="#aaa5d6">No stored history is available for this window.</text>`;
  }
  const delta =
    summary.firstTrophies === null || summary.latestTrophies === null
      ? '—'
      : `${summary.latestTrophies - summary.firstTrophies >= 0 ? '+' : ''}${(summary.latestTrophies - summary.firstTrophies).toLocaleString('en-US')}`;
  const tiles = [
    ['SNAPSHOTS', formatNumber(summary.points), '#46d6ff'],
    ['TROPHY CHANGE', delta, '#7de2a0'],
    ['CLUB CHANGES', formatNumber(summary.clubChanges), '#8f82ff'],
    ['MEGAPIG WINS', formatNumber(summary.megaPig?.wins ?? null), '#ff8fab'],
  ] as const;
  const markup = tiles
    .map(([label, value, color], index) => {
      const x = 64 + (index % 2) * 552;
      const y = 340 + Math.floor(index / 2) * 96;
      return `<rect x="${x}" y="${y}" width="530" height="86" rx="18" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.09"/>
        <text x="${x + 20}" y="${y + 28}" font-size="12" font-weight="700" letter-spacing="1.4" fill="${color}">${escapeXml(label)}</text>
        <text x="${x + 20}" y="${y + 64}" font-size="26" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(value, 20))}</text>`;
    })
    .join('');
  const first = summary.firstAt === null ? '—' : formatDate(summary.firstAt);
  const latest = summary.latestAt === null ? '—' : formatDate(summary.latestAt);
  const events = summary.events
    .slice(0, 4)
    .map((event, index) => {
      const date = event.date === null ? '—' : formatDate(event.date);
      return `<text x="64" y="${548 + index * 20}" font-size="13" fill="#cfc9ff">${escapeXml(date)} • ${escapeXml(truncate(event.label, 74))}</text>`;
    })
    .join('');
  const mega =
    summary.megaPig === null
      ? 'No stored Mega Pig record'
      : `Mega Pig ${formatDate(summary.megaPig.date)} • ${formatNumber(summary.megaPig.wins)} wins • ${formatNumber(summary.megaPig.draws)} draws • ${formatNumber(summary.megaPig.losses)} losses • ${formatNumber(summary.megaPig.ticketsUsed)} tickets`;
  return `${markup}
    <text x="64" y="536" font-size="12" font-weight="700" letter-spacing="1.4" fill="#8f82ff">CLUB MEMBERSHIP EVENTS</text>
    ${events}
    <text x="64" y="632" font-size="12" fill="#8e88bd">${escapeXml(truncate(mega, 110))}</text>
    <text x="1136" y="632" text-anchor="end" font-size="11" fill="#8e88bd">Snapshots ${escapeXml(first)} → ${escapeXml(latest)}</text>`;
}

function modeDefs(mode: PlayerCardMode, gridCount: number): string {
  if (mode === 'brawler') {
    return `<clipPath id="focusClip"><rect width="160" height="160" rx="30"/></clipPath>`;
  }
  if (mode === 'rank' || mode === 'trophies' || mode === 'highest') {
    return Array.from({ length: gridCount }, (_, index) =>
      `<clipPath id="modeClip${index}"><rect width="34" height="34" rx="9"/></clipPath>`,
    ).join('');
  }
  return '';
}

/** Render one of the BrawlTools-style `/me image` modes as PNG bytes. */
async function buildPlayerModeImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets,
  options: PlayerCardOptions,
): Promise<Buffer> {
  const mode = options.mode ?? 'profile';
  const player = profile.player;
  const displayName = truncate(player.name, 24);
  const tag = `#${player.tag}`;
  const club = profile.currentClub;
  const sourceLabel = profile.source === 'live' ? 'LIVE OFFICIAL DATA' : 'STORED OFFICIAL DATA';
  const updated = formatDate(profile.profileFetchedAt ?? profile.latestSnapshotAt);

  const [playerIcon, clubBadge] = await Promise.all([
    assetDataUrl(assets.playerIconUrl, 156),
    assetDataUrl(assets.clubBadgeUrl, 58),
  ]);

  const gridBrawlers =
    mode === 'rank' || mode === 'trophies' || mode === 'highest'
      ? sortedModeBrawlers(profile, mode).slice(0, 24)
      : [];
  const gridPortraits = await Promise.all(
    gridBrawlers.map((brawler) => brawlerPortraitDataUrl(brawler.name, assets)),
  );

  const focused = mode === 'brawler' ? focusBrawler(profile, options) : undefined;
  const focusedPortrait =
    focused === undefined
      ? null
      : await brawlerPortraitDataUrl(
          focused.name,
          assets.allBrawlerPortraitUrls?.[focused.name] === undefined
            ? { ...assets, allBrawlerPortraitUrls: { [focused.name]: assets.brawlerPortraitUrls?.[0] } }
            : assets,
        );

  let body: string;
  if (mode === 'season') {
    body = seasonMarkup(profile, options.seasonWindow);
  } else if (mode === 'history') {
    body = historyMarkup(options.history);
  } else if (mode === 'brawler') {
    body = focusMarkup(focused, focusedPortrait, options.brawlerDetail);
  } else {
    body = gridMarkup(gridBrawlers, gridPortraits, mode);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11102b"/>
      <stop offset="55%" stop-color="#1c1748"/>
      <stop offset="100%" stop-color="#34216b"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#292353"/>
      <stop offset="100%" stop-color="#1b173c"/>
    </linearGradient>
    <clipPath id="avatarClip"><circle cx="144" cy="228" r="78"/></clipPath>
    <clipPath id="clubClip"><rect x="786" y="154" width="58" height="58" rx="14"/></clipPath>
    ${modeDefs(mode, gridBrawlers.length)}
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#background)"/>
  <circle cx="1090" cy="40" r="240" fill="#9a7dff" fill-opacity="0.12"/>
  <circle cx="1120" cy="690" r="180" fill="#46d6ff" fill-opacity="0.08"/>
  <rect x="42" y="34" width="356" height="44" rx="22" fill="#ffffff" fill-opacity="0.08"/>
  <text x="64" y="63" font-size="17" font-weight="700" letter-spacing="2.2" fill="#dcd6ff">BRAWLHUB • PLAYER IMAGE</text>
  <text x="1158" y="63" text-anchor="end" font-size="14" font-weight="700" letter-spacing="1.4" fill="#aaa5d6">${escapeXml(sourceLabel)}</text>
  <rect x="40" y="104" width="1120" height="548" rx="30" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  ${avatarMarkup(playerIcon, displayName)}
  <text x="252" y="198" font-size="43" font-weight="700" fill="#f7f6ff">${escapeXml(displayName)}</text>
  <text x="252" y="236" font-size="24" font-weight="600" fill="#aaa5d6">${escapeXml(tag)}</text>
  ${badgeMarkup(assets.badges ?? [], 252, 258)}
  <rect x="760" y="138" width="360" height="98" rx="20" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.08"/>
  ${clubMarkup(clubBadge)}
  <text x="858" y="178" font-size="19" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(club?.name ?? 'No club recorded', 24))}</text>
  <text x="858" y="207" font-size="15" fill="#aaa5d6">${escapeXml(formatRole(club?.role ?? null))}</text>
  <text x="64" y="332" font-size="14" font-weight="700" letter-spacing="1.7" fill="#aaa5d6">${escapeXml(modeHeading(mode))}</text>
  <text x="1136" y="332" text-anchor="end" font-size="12" fill="#8e88bd">BRAWLTOOLS-STYLE PRESET</text>
  ${body}
  <text x="42" y="695" font-size="13" fill="#8e88bd">Official Brawl Stars data • Static BrawlAPI assets • Updated ${escapeXml(updated)}</text>
  <text x="1158" y="695" text-anchor="end" font-size="13" fill="#8e88bd">Made for ${escapeXml(truncate(player.name, 28))}</text>
</svg>`;

  return sharp(Buffer.from(svg), { limitInputPixels: MAX_INPUT_PIXELS })
    .png()
    .toBuffer();
}

/** Render a public Spotlight-style player profile card as PNG bytes. */
export async function buildPlayerCardImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets = {},
  options: PlayerCardOptions = {},
): Promise<Buffer> {
  if (options.mode !== undefined && options.mode !== 'profile') {
    return buildPlayerModeImage(profile, assets, options);
  }

  const player = profile.player;
  const displayName = truncate(player.name, 24);
  const tag = `#${player.tag}`;
  const club = profile.currentClub;
  const brawlers = selectTopBrawlers(profile);
  const portraits = await Promise.all(
    brawlers.map((brawler, index) => assetDataUrl(assets.brawlerPortraitUrls?.[index], 64)),
  );

  const [playerIcon, clubBadge] = await Promise.all([
    assetDataUrl(assets.playerIconUrl, 156),
    assetDataUrl(assets.clubBadgeUrl, 58),
  ]);

  const wins = [
    player.threeVsThreeVictories,
    player.soloVictories,
    player.duoVictories,
  ].reduce<number>((total, value) => total + (value ?? 0), 0);
  const brawlerCount = profile.stats?.brawlerCount ?? profile.brawlers.length;
  const ranked = player.rankedRankName ?? player.highestSeasonRankedRankName ?? '—';
  const sourceLabel = profile.source === 'live' ? 'LIVE OFFICIAL DATA' : 'STORED OFFICIAL DATA';
  const updated = formatDate(profile.profileFetchedAt ?? profile.latestSnapshotAt);
  const level = player.expLevel === null ? '—' : `Level ${player.expLevel}`;
  const power11 = profile.brawlers.filter((brawler) => brawler.power === 11).length;
  const gadgetTotal = profile.brawlers.reduce((total, brawler) => total + (brawler.gadgets ?? 0), 0);
  const starPowerTotal = profile.brawlers.reduce((total, brawler) => total + (brawler.starPowers ?? 0), 0);
  const gearTotal = profile.brawlers.reduce((total, brawler) => total + (brawler.gears ?? 0), 0);
  const streaks = profile.brawlers.flatMap((brawler) =>
    brawler.maxWinStreak === null || brawler.maxWinStreak === undefined ? [] : [brawler.maxWinStreak],
  );
  const longestStreak = streaks.length === 0 ? '—' : formatNumber(Math.max(...streaks));
  const bestBrawler = brawlers[0];
  const bestBrawlerValue = bestBrawler === undefined
    ? '—'
    : formatNumber(bestBrawler.highestTrophies ?? bestBrawler.trophies ?? null);

  const brawlerCards = BRAWLER_X.map((x, index) =>
    brawlerMarkup(x, 548, index, brawlers[index], portraits[index] ?? null),
  ).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11102b"/>
      <stop offset="55%" stop-color="#1c1748"/>
      <stop offset="100%" stop-color="#34216b"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#292353"/>
      <stop offset="100%" stop-color="#1b173c"/>
    </linearGradient>
    <clipPath id="avatarClip"><circle cx="144" cy="228" r="78"/></clipPath>
    <clipPath id="clubClip"><rect x="786" y="154" width="58" height="58" rx="14"/></clipPath>
    ${BRAWLER_X.map((x, index) => `<clipPath id="brawlerClip${index}"><rect x="${x + 14}" y="560" width="56" height="56" rx="14"/></clipPath>`).join('')}
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#background)"/>
  <circle cx="1090" cy="40" r="240" fill="#9a7dff" fill-opacity="0.12"/>
  <circle cx="1120" cy="690" r="180" fill="#46d6ff" fill-opacity="0.08"/>
  <rect x="42" y="34" width="330" height="44" rx="22" fill="#ffffff" fill-opacity="0.08"/>
  <text x="64" y="63" font-size="17" font-weight="700" letter-spacing="2.2" fill="#dcd6ff">BRAWLHUB • PLAYER CARD</text>
  <text x="1158" y="63" text-anchor="end" font-size="14" font-weight="700" letter-spacing="1.4" fill="#aaa5d6">${escapeXml(sourceLabel)}</text>
  <rect x="40" y="104" width="1120" height="548" rx="30" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.12"/>
  ${avatarMarkup(playerIcon, displayName)}
  <text x="252" y="198" font-size="43" font-weight="700" fill="#f7f6ff">${escapeXml(displayName)}</text>
  <text x="252" y="236" font-size="24" font-weight="600" fill="#aaa5d6">${escapeXml(tag)}</text>
  ${badgeMarkup(assets.badges ?? [], 252, 258)}
  <text x="70" y="300" font-size="13" fill="#aaa5d6">Fame ${escapeXml(formatNumber(player.fame ?? null))} • Prestige ${escapeXml(formatNumber(player.totalPrestigeLevel ?? null))} • Account ${escapeXml(formatNumber(player.expLevel ?? null))} • Longest streak ${escapeXml(longestStreak)}</text>
  <text x="70" y="319" font-size="13" fill="#aaa5d6">Power 11 ${power11} • Gadgets ${gadgetTotal} • Star Powers ${starPowerTotal} • Gears ${gearTotal} • Best brawler ${escapeXml(bestBrawler?.name ?? '—')} ${escapeXml(bestBrawlerValue)}</text>
  <rect x="760" y="138" width="360" height="98" rx="20" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.08"/>
  ${clubMarkup(clubBadge)}
  <text x="858" y="178" font-size="19" font-weight="700" fill="#f7f6ff">${escapeXml(truncate(club?.name ?? 'No club recorded', 24))}</text>
  <text x="858" y="207" font-size="15" fill="#aaa5d6">${escapeXml(formatRole(club?.role ?? null))}</text>
  ${statMarkup(70, 334, 'Trophies', formatNumber(player.trophies), '#46d6ff')}
  ${statMarkup(420, 334, 'Highest', formatNumber(player.highestTrophies), '#ffd166')}
  ${statMarkup(770, 334, 'Experience', level, '#8f82ff')}
  ${statMarkup(70, 434, 'Ranked', ranked, '#ff8fab')}
  ${statMarkup(420, 434, 'Victories', formatNumber(wins), '#7de2a0')}
  ${statMarkup(770, 434, 'Brawlers', formatNumber(brawlerCount), '#c58cff')}
  <text x="70" y="538" font-size="14" font-weight="700" letter-spacing="1.7" fill="#aaa5d6">TOP BRAWLERS</text>
  ${brawlerCards}
  <text x="42" y="695" font-size="13" fill="#8e88bd">Official Brawl Stars data • Static BrawlAPI assets • Updated ${escapeXml(updated)}</text>
  <text x="1158" y="695" text-anchor="end" font-size="13" fill="#8e88bd">Made for ${escapeXml(truncate(player.name, 28))}</text>
</svg>`;

  return sharp(Buffer.from(svg), { limitInputPixels: MAX_INPUT_PIXELS })
    .png()
    .toBuffer();
}
