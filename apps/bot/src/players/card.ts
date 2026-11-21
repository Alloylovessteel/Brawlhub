import sharp from 'sharp';
import type { PlayerBrawler, PlayerProfileView } from './types';

/**
 * Static image assets passed in by the command layer. URLs come only from the
 * BrawlAPI static metadata resolver; every value shown on the card comes from
 * the official Brawl Stars player profile in `PlayerProfileView`.
 */
export interface PlayerCardAssets {
  readonly playerIconUrl?: string | null;
  readonly clubBadgeUrl?: string | null;
  readonly brawlerPortraitUrls?: readonly (string | null | undefined)[];
  readonly badges?: readonly string[];
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

/** Render a public Spotlight-style player profile card as PNG bytes. */
export async function buildPlayerCardImage(
  profile: PlayerProfileView,
  assets: PlayerCardAssets = {},
): Promise<Buffer> {
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
