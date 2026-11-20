/** Toggleable sections of the auto-posted club overview, backed by stored data. */
export const OVERVIEW_FIELD_KEYS = [
  'clubTrophies',
  'trophyRange',
  'requiredTrophies',
  'rankedRange',
  'staff',
  'members',
  'active24h',
  'serverIcon',
  'megaPigEstimate',
  'orderByTrophies',
] as const;

export type OverviewFieldKey = (typeof OVERVIEW_FIELD_KEYS)[number];

export const OVERVIEW_FIELD_LABELS: Readonly<Record<OverviewFieldKey, string>> = {
  clubTrophies: 'Club trophies',
  trophyRange: 'Club trophy range',
  requiredTrophies: 'Required trophies',
  rankedRange: 'Ranked range',
  staff: 'Club staff',
  members: 'Member count',
  active24h: 'Active 24h (stored battles)',
  serverIcon: 'Server icon',
  megaPigEstimate: 'Mega Pig estimate (stored)',
  orderByTrophies: 'Order by club trophies',
};

/** All fields on by default; an empty stored value keeps legacy behavior. */
export const DEFAULT_OVERVIEW_FIELDS: readonly OverviewFieldKey[] = OVERVIEW_FIELD_KEYS;

export function isOverviewFieldKey(value: string): value is OverviewFieldKey {
  return (OVERVIEW_FIELD_KEYS as readonly string[]).includes(value);
}

/** Normalize any stored value into a valid, de-duplicated field selection. */
export function normalizeOverviewFields(value: unknown): OverviewFieldKey[] {
  if (!Array.isArray(value)) return [...DEFAULT_OVERVIEW_FIELDS];
  const keys = value.filter(
    (item): item is OverviewFieldKey => typeof item === 'string' && isOverviewFieldKey(item),
  );
  const unique = [...new Set(keys)];
  return unique.length === 0 ? [...DEFAULT_OVERVIEW_FIELDS] : unique;
}

/** Toggle one field while always keeping at least one field enabled. */
export function toggleOverviewField(
  fields: readonly string[] | null | undefined,
  key: OverviewFieldKey,
): OverviewFieldKey[] {
  const current = normalizeOverviewFields(fields);
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
  return next.length === 0 ? current : next;
}

export function hasOverviewField(
  fields: readonly string[] | null | undefined,
  key: OverviewFieldKey,
): boolean {
  return normalizeOverviewFields(fields).includes(key);
}
