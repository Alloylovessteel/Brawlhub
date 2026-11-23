/** Dropdown modes for `/me image`, modelled on BrawlTools' `/image-me` picker. */

export const ME_IMAGE_MODES = [
  'profile',
  'brawler',
  'rank',
  'trophies',
  'highest',
  'season',
  'history',
] as const;

export type MeImageMode = (typeof ME_IMAGE_MODES)[number];

export const DEFAULT_ME_IMAGE_MODE: MeImageMode = 'profile';

export const ME_IMAGE_MODE_CHOICES: ReadonlyArray<{
  readonly name: string;
  readonly value: MeImageMode;
}> = [
  { name: 'Player Profile', value: 'profile' },
  { name: 'Brawler', value: 'brawler' },
  { name: 'Brawler Rank', value: 'rank' },
  { name: 'Brawler Trophies', value: 'trophies' },
  { name: 'Brawler Highest Trophies', value: 'highest' },
  { name: 'Season Progress', value: 'season' },
  { name: 'Player History', value: 'history' },
];

export function isMeImageMode(value: string | null | undefined): value is MeImageMode {
  return value !== null && value !== undefined && ME_IMAGE_MODES.includes(value as MeImageMode);
}
