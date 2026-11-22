/**
 * Pure tier helpers for declarative auto roles.
 *
 * Nothing in this module talks to Discord, Supabase or the Brawl Stars API.
 * Ranked/club keys mirror the conventions in `ranked-roles/service.ts` and
 * `club-roles/service.ts`; all other values come from official-derived player
 * fields already stored in the database.
 */

export const ROLE_KINDS = [
  { kind: 'verify', label: 'Verify' },
  { kind: 'trophy', label: 'Trophy' },
  { kind: 'solo_win', label: 'Solo Win' },
  { kind: 'duo_win', label: 'Duo Win' },
  { kind: 'vs_win', label: '3vs3 Win' },
  { kind: 'brawler', label: 'Brawler' },
  { kind: 'level', label: 'Level' },
  { kind: 'ranked', label: 'Ranked League' },
  { kind: 'club', label: 'Club' },
  { kind: 'fame', label: 'Fame' },
] as const;

export type RoleKind = (typeof ROLE_KINDS)[number]['kind'];

const ROLE_KIND_VALUES: readonly string[] = ROLE_KINDS.map((entry) => entry.kind);

export function isRoleKind(value: unknown): value is RoleKind {
  return typeof value === 'string' && ROLE_KIND_VALUES.includes(value);
}

export const ROLE_KIND_LABELS: Readonly<Record<RoleKind, string>> = {
  verify: 'Verify',
  trophy: 'Trophy',
  solo_win: 'Solo Win',
  duo_win: 'Duo Win',
  vs_win: '3vs3 Win',
  brawler: 'Brawler',
  level: 'Level',
  ranked: 'Ranked League',
  club: 'Club',
  fame: 'Fame',
};

/**
 * Default tier keys written by `/auto setup`. Threshold kinds are ascending;
 * reconciliation grants only the highest tier the player actually reaches.
 */
export const DEFAULT_TIER_KEYS: Readonly<Record<RoleKind, readonly string[]>> = {
  verify: ['verified'],
  trophy: ['5000', '10000', '20000', '30000', '50000'],
  solo_win: ['100', '500', '1000', '5000'],
  duo_win: ['100', '500', '1000', '5000'],
  vs_win: ['100', '500', '1000', '5000'],
  brawler: ['10', '20', '30', '40', '50'],
  level: ['25', '35', '50', '70', '100'],
  ranked: ['BRONZE', 'SILVER', 'GOLD', 'DIAMOND', 'MYTHIC', 'LEGENDARY', 'MASTERS', 'PRO'],
  club: ['senior', 'vicePresident', 'president'],
  fame: ['1000', '5000', '10000', '20000', '35000'],
};

/** Inputs are already parsed from official-derived database fields. */
export interface TierSource {
  readonly verified?: boolean | null | undefined;
  readonly trophies?: number | null | undefined;
  readonly soloVictories?: number | null | undefined;
  readonly duoVictories?: number | null | undefined;
  readonly vsVictories?: number | null | undefined;
  readonly brawlerCount?: number | null | undefined;
  readonly level?: number | null | undefined;
  readonly rankedRankName?: string | null | undefined;
  readonly clubRank?: string | null | undefined;
  readonly clubRoles?: readonly unknown[] | null | undefined;
  readonly fame?: number | null | undefined;
}

const CLUB_RANK_ORDER = ['senior', 'vicePresident', 'president'] as const;
type ClubRank = (typeof CLUB_RANK_ORDER)[number];

const CLUB_RANK_LABELS: Readonly<Record<ClubRank, string>> = {
  senior: 'Senior',
  vicePresident: 'Vice President',
  president: 'President',
};

const RANKED_COLORS: Readonly<Record<string, number>> = {
  BRONZE: 0xcd7f32,
  SILVER: 0xc0c0c0,
  GOLD: 0xffd700,
  DIAMOND: 0x00bcd4,
  MYTHIC: 0x9c27b0,
  LEGENDARY: 0xff9800,
  MASTERS: 0xe91e63,
  PRO: 0xf44336,
};

const CLUB_COLORS: Readonly<Record<ClubRank, number>> = {
  senior: 0x3f51b5,
  vicePresident: 0x9c27b0,
  president: 0xffd700,
};

const KIND_COLORS: Readonly<Record<RoleKind, number>> = {
  verify: 0x57f287,
  trophy: 0xffd700,
  solo_win: 0x5865f2,
  duo_win: 0xeb459e,
  vs_win: 0x00bcd4,
  brawler: 0xe67e22,
  level: 0x9c27b0,
  ranked: 0xf44336,
  club: 0x3f51b5,
  fame: 0xf1c40f,
};

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactNumber(value: string): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 1000 && numeric % 1000 === 0) {
    return `${numeric / 1000}K`;
  }
  return value;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** Mirror of `rankedTierFromRankName`: only the leading official tier token. */
export function parseRankedTierKey(rankName: string | null | undefined): string | null {
  if (typeof rankName !== 'string' || rankName.trim() === '') return null;
  const token = rankName.trim().split(/\s+/)[0]?.toUpperCase();
  if (token === undefined) return null;
  return DEFAULT_TIER_KEYS.ranked.find((tier) => tier === token) ?? null;
}

/** Mirror of `clubRoleRankFromRole`: only the three official roster ranks. */
export function parseClubRankKey(value: unknown): ClubRank | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'vicepresident') return 'vicePresident';
  return CLUB_RANK_ORDER.find((rank) => rank.toLowerCase() === normalized) ?? null;
}

/** Highest of several official club role values; unknown values are ignored. */
export function chooseClubRankKey(values: readonly unknown[]): ClubRank | null {
  let best: ClubRank | null = null;
  for (const value of values) {
    const rank = parseClubRankKey(value);
    if (rank === null) continue;
    if (best === null || CLUB_RANK_ORDER.indexOf(rank) > CLUB_RANK_ORDER.indexOf(best)) best = rank;
  }
  return best;
}

/** Highest configured threshold at or below the official value, or null. */
export function thresholdTierKey(
  tierKeys: readonly string[],
  value: number | null | undefined,
): string | null {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  const sorted = tierKeys
    .map((tierKey) => ({ tierKey, threshold: Number(tierKey) }))
    .filter((entry) => Number.isFinite(entry.threshold))
    .sort((a, b) => a.threshold - b.threshold);
  let best: string | null = null;
  for (const entry of sorted) {
    if (numeric >= entry.threshold) best = entry.tierKey;
  }
  return best;
}

/**
 * Compute the single tier key a player qualifies for in one role kind.
 * Missing or unrecognised official data always yields no tier; nothing is guessed.
 */
export function computeDesiredTierKeys(
  kind: RoleKind,
  source: TierSource,
  configuredTierKeys: readonly string[] = DEFAULT_TIER_KEYS[kind],
): string[] {
  if (kind === 'verify') {
    return source.verified === true && configuredTierKeys.includes('verified') ? ['verified'] : [];
  }

  if (kind === 'ranked') {
    const tier = parseRankedTierKey(source.rankedRankName);
    if (tier === null) return [];
    const configured = configuredTierKeys.find(
      (tierKey) => tierKey.toUpperCase() === tier.toUpperCase(),
    );
    return configured === undefined ? [] : [configured];
  }

  if (kind === 'club') {
    const best = chooseClubRankKey([
      ...(source.clubRoles ?? []),
      ...(source.clubRank === null || source.clubRank === undefined ? [] : [source.clubRank]),
    ]);
    if (best === null) return [];
    for (let index = CLUB_RANK_ORDER.indexOf(best); index >= 0; index -= 1) {
      const candidate = CLUB_RANK_ORDER[index];
      if (candidate === undefined) continue;
      const configured = configuredTierKeys.find(
        (tierKey) => parseClubRankKey(tierKey) === candidate,
      );
      if (configured !== undefined) return [configured];
    }
    return [];
  }

  let value: number | null | undefined;
  switch (kind) {
    case 'trophy':
      value = source.trophies;
      break;
    case 'solo_win':
      value = source.soloVictories;
      break;
    case 'duo_win':
      value = source.duoVictories;
      break;
    case 'vs_win':
      value = source.vsVictories;
      break;
    case 'brawler':
      value = source.brawlerCount;
      break;
    case 'level':
      value = source.level;
      break;
    case 'fame':
      value = source.fame;
      break;
  }
  const tier = thresholdTierKey(configuredTierKeys, value);
  return tier === null ? [] : [tier];
}

/** Count distinct owned brawlers from the official `profile_extra` payload. */
export function countProfileBrawlers(profileExtra: unknown): number | null {
  if (profileExtra === null || typeof profileExtra !== 'object') return null;
  const brawlers = (profileExtra as Record<string, unknown>)['brawlers'];
  if (!Array.isArray(brawlers)) return null;
  const seen = new Set<string>();
  for (const entry of brawlers) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'].trim().toLowerCase() : '';
    const id = typeof row['id'] === 'number' && Number.isFinite(row['id']) ? row['id'] : null;
    if (name !== '') seen.add(`name:${name}`);
    else if (id !== null) seen.add(`id:${id}`);
  }
  return seen.size;
}

export function clubRoleLabel(tierKey: string): string {
  return CLUB_RANK_LABELS[parseClubRankKey(tierKey) ?? 'senior'];
}

/** Stable Discord role name used when a role must be created. */
export function defaultRoleName(kind: RoleKind, tierKey: string): string {
  switch (kind) {
    case 'verify':
      return 'BrawlHub Verified';
    case 'ranked':
      return `FN ${titleCase(tierKey)}`;
    case 'club':
      return `Club ${clubRoleLabel(tierKey)}`;
    case 'trophy':
      return `Trophy ${compactNumber(tierKey)}+`;
    case 'solo_win':
      return `Solo Wins ${compactNumber(tierKey)}+`;
    case 'duo_win':
      return `Duo Wins ${compactNumber(tierKey)}+`;
    case 'vs_win':
      return `3vs3 Wins ${compactNumber(tierKey)}+`;
    case 'brawler':
      return `${tierKey}+ Brawlers`;
    case 'level':
      return `Level ${tierKey}+`;
    case 'fame':
      return `Fame ${compactNumber(tierKey)}+`;
  }
}

/** Names checked before creating a role, including the previous Phase 4 names. */
export function candidateRoleNames(kind: RoleKind, tierKey: string): readonly string[] {
  const name = defaultRoleName(kind, tierKey);
  if (kind === 'verify') return [name, 'Verified'];
  if (kind === 'ranked') return [name, `FN ${tierKey}`];
  if (kind === 'club') return [name, `Club ${titleCase(tierKey)}`];
  return [name];
}

export function roleColor(kind: RoleKind, tierKey: string): number {
  if (kind === 'ranked') return RANKED_COLORS[tierKey.toUpperCase()] ?? KIND_COLORS.ranked;
  if (kind === 'club') {
    const rank = parseClubRankKey(tierKey) ?? 'senior';
    return CLUB_COLORS[rank];
  }
  return KIND_COLORS[kind];
}

/** Deterministic ordering for setup writes and reconciliation. */
export function priorityFor(kind: RoleKind, tierIndex: number): number {
  const kindIndex = ROLE_KINDS.findIndex((entry) => entry.kind === kind);
  return (kindIndex < 0 ? 0 : kindIndex) * 100 + tierIndex * 10;
}
