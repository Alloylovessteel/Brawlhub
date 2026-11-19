import { createBrawlApiClient, type BrawlApiClient } from '@brawlhub/brawlapi';
import { createBrawlStarsClient, type BrawlStarsClient } from '@brawlhub/brawl-stars';

export interface VerificationTargetIcon {
  readonly id: number;
  readonly name: string;
  readonly imageUrl: string;
}

export const DEFAULT_BRAWLER_VERIFICATION_ICONS: readonly VerificationTargetIcon[] = [
  { id: 28000003, name: 'Shelly', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000003.png' },
  { id: 28000004, name: 'Colt', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000004.png' },
  { id: 28000005, name: 'Brock', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000005.png' },
  { id: 28000006, name: 'Jessie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000006.png' },
  { id: 28000007, name: 'Nita', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000007.png' },
  { id: 28000008, name: 'Dynamike', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000008.png' },
  { id: 28000009, name: 'El Primo', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000009.png' },
  { id: 28000010, name: 'Bull', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000010.png' },
  { id: 28000011, name: 'Rico', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000011.png' },
  { id: 28000012, name: 'Barley', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000012.png' },
  { id: 28000013, name: 'Poco', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000013.png' },
  { id: 28000014, name: 'Mortis', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000014.png' },
  { id: 28000015, name: 'Bo', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000015.png' },
  { id: 28000016, name: 'Spike', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png' },
  { id: 28000017, name: 'Crow', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000017.png' },
  { id: 28000018, name: 'Piper', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000018.png' },
  { id: 28000028, name: 'Pam', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000028.png' },
  { id: 28000029, name: 'Tara', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000029.png' },
  { id: 28000034, name: 'Darryl', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000034.png' },
  { id: 28000035, name: 'Penny', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000035.png' },
  { id: 28000036, name: 'Frank', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000036.png' },
  { id: 28000037, name: 'Leon', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000037.png' },
  { id: 28000038, name: 'Gene', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000038.png' },
  { id: 28000039, name: 'Carl', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000039.png' },
  { id: 28000040, name: 'Rosa', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000040.png' },
  { id: 28000041, name: 'Bibi', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000041.png' },
  { id: 28000042, name: 'Tick', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000042.png' },
  { id: 28000043, name: '8-Bit', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000043.png' },
  { id: 28000044, name: 'Sandy', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000044.png' },
  { id: 28000045, name: 'Emz', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000045.png' },
  { id: 28000046, name: 'Bea', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000046.png' },
  { id: 28000047, name: 'Max', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000047.png' },
  { id: 28000048, name: 'Mr. P', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000048.png' },
  { id: 28000049, name: 'Jacky', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000049.png' },
  { id: 28000050, name: 'Sprout', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000050.png' },
  { id: 28000051, name: 'Gale', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000051.png' },
  { id: 28000052, name: 'Nani', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000052.png' },
  { id: 28000053, name: 'Surge', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000053.png' },
  { id: 28000054, name: 'Colette', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000054.png' },
  { id: 28000055, name: 'Amber', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000055.png' },
  { id: 28000056, name: 'Lou', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000056.png' },
  { id: 28000057, name: 'Byron', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000057.png' },
  { id: 28000058, name: 'Edgar', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000058.png' },
  { id: 28000059, name: 'Ruffs', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000059.png' },
  { id: 28000062, name: 'Stu', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000062.png' },
  { id: 28000065, name: 'Belle', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000065.png' },
  { id: 28000066, name: 'Squeak', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000066.png' },
  { id: 28000067, name: 'Buzz', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000067.png' },
  { id: 28000068, name: 'Griff', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000068.png' },
  { id: 28000071, name: 'Ash', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000071.png' },
  { id: 28000074, name: 'Meg', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000074.png' },
  { id: 28000075, name: 'Lola', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000075.png' },
  { id: 28000080, name: 'Grom', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000080.png' },
  { id: 28000081, name: 'Fang', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000081.png' },
  { id: 28000082, name: 'Eve', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000082.png' },
  { id: 28000085, name: 'Janet', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000085.png' },
  { id: 28000086, name: 'Bonnie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000086.png' },
  { id: 28000105, name: 'Otis', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000105.png' },
  { id: 28000149, name: 'Sam', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000149.png' },
  { id: 28000150, name: 'Gus', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000150.png' },
  { id: 28000160, name: 'Buster', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000160.png' },
  { id: 28000183, name: 'Gray', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000183.png' },
  { id: 28000184, name: 'Mandy', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000184.png' },
  { id: 28000185, name: 'Chester', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000185.png' },
  { id: 28000245, name: 'R-T', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000245.png' },
  { id: 28000246, name: 'Willow', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000246.png' },
  { id: 28000265, name: 'Maisie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000265.png' },
  { id: 28000266, name: 'Hank', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000266.png' },
  { id: 28000288, name: 'Cordelius', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000288.png' },
  { id: 28000289, name: 'Doug', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000289.png' },
  { id: 28000319, name: 'Pearl', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000319.png' },
  { id: 28000320, name: 'Chuck', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000320.png' },
  { id: 28000333, name: 'Charlie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000333.png' },
  { id: 28000381, name: 'Mico', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000381.png' },
  { id: 28000382, name: 'Kit', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000382.png' },
  { id: 28000387, name: 'Larry & Lawrie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000387.png' },
  { id: 28000429, name: 'Melodie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000429.png' },
  { id: 28000430, name: 'Angelo', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000430.png' },
  { id: 28000464, name: 'Lily', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000464.png' },
  { id: 28000465, name: 'Draco', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000465.png' },
  { id: 28000531, name: 'Clancy', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000531.png' },
  { id: 28000532, name: 'Berry', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000532.png' },
  { id: 28000593, name: 'Kenji', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000593.png' },
  { id: 28000613, name: 'Moe', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000613.png' },
  { id: 28000648, name: 'Juju', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000648.png' },
  { id: 28000649, name: 'Shade', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000649.png' },
  { id: 28000663, name: 'Moe (Alt)', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000663.png' },
  { id: 28000678, name: 'Buzz Lightyear', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000678.png' },
  { id: 28000704, name: 'Meeple', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000704.png' },
  { id: 28000705, name: 'Ollie', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000705.png' },
  { id: 28000806, name: 'Finx', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000806.png' },
  { id: 28000807, name: 'Lumi', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000807.png' },
  { id: 28000831, name: 'Kaze', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000831.png' },
  { id: 28000832, name: 'Jae-yong', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000832.png' },
  { id: 28000899, name: 'Trunk', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000899.png' },
  { id: 28000923, name: 'Alli', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000923.png' },
  { id: 28000934, name: 'Mina', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000934.png' },
  { id: 28000935, name: 'Ziggy', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000935.png' },
  { id: 28001006, name: 'Gigi', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001006.png' },
  { id: 28001073, name: 'Pierce', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001073.png' },
  { id: 28001074, name: 'Glowbert', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001074.png' },
  { id: 28001078, name: 'Sirius', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001078.png' },
  { id: 28001195, name: 'Najia', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001195.png' },
  { id: 28001225, name: 'Damian', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001225.png' },
  { id: 28001227, name: 'Stella', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001227.png' },
  { id: 28001254, name: 'Bolt', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001254.png' },
  { id: 28001286, name: 'Nori', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001286.png' },
  { id: 28001287, name: 'Wendy', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001287.png' },
  { id: 28001337, name: 'Cosmo', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001337.png' },
  { id: 28001338, name: 'Vince', imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28001338.png' },
] as const;

export function pickRandomVerificationIcon(excludeId?: number): VerificationTargetIcon {
  const pool =
    excludeId === undefined
      ? DEFAULT_BRAWLER_VERIFICATION_ICONS
      : DEFAULT_BRAWLER_VERIFICATION_ICONS.filter((icon) => icon.id !== excludeId);
  const source = pool.length > 0 ? pool : DEFAULT_BRAWLER_VERIFICATION_ICONS;
  const index = Math.floor(Math.random() * source.length);
  return source[index]!;
}

export function formatVerificationIconName(icon: VerificationTargetIcon): string {
  return icon.name;
}

const VERIFICATION_ICON_CACHE_TTL_MS = 60 * 60 * 1000;
let verificationIconCache: { readonly icons: readonly VerificationTargetIcon[]; readonly at: number } | null =
  null;

/** Official API names are authoritative; BrawlAPI only supplies the icon image. */
function toDisplayBrawlerName(officialName: string): string {
  return officialName
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Load the current default brawler icon pool.
 *
 * Official `/brawlers` provides the authoritative brawler names and IDs;
 * BrawlAPI `/v1/icons` supplies the profile-icon image URLs that the official
 * API does not expose. Any failure falls back to the bundled icon list so
 * verification remains available offline.
 */
export async function loadBrawlerVerificationIcons(): Promise<readonly VerificationTargetIcon[]> {
  const cached = verificationIconCache;
  if (cached !== null && Date.now() - cached.at < VERIFICATION_ICON_CACHE_TTL_MS) {
    return cached.icons;
  }

  const brawlApi: BrawlApiClient = createBrawlApiClient();
  const official: BrawlStarsClient = createBrawlStarsClient();
  try {
    const [iconsResponse, brawlers] = await Promise.all([
      brawlApi.getIconCatalog(),
      official.getBrawlers(),
    ]);
    const names = new Map(brawlers.map((brawler) => [brawler.id, toDisplayBrawlerName(brawler.name)]));
    const icons = Object.values(iconsResponse.player)
      .filter((icon) => icon.brawler !== null && icon.brawler !== undefined)
      .filter((icon) => icon.name2?.startsWith('player_icon_') === true)
      .flatMap((icon) => {
        const brawlerId = icon.brawler;
        if (brawlerId === null || brawlerId === undefined) return [];
        const name = names.get(brawlerId);
        if (name === undefined) return [];
        return [
          {
            id: icon.id,
            name,
            imageUrl: icon.imageUrl,
          },
        ];
      });

    if (icons.length >= DEFAULT_BRAWLER_VERIFICATION_ICONS.length) {
      verificationIconCache = { icons, at: Date.now() };
      return icons;
    }
  } catch {
    // Static metadata is optional; keep the bundled pool on failure.
  }

  return DEFAULT_BRAWLER_VERIFICATION_ICONS;
}

/** Pick from the freshest available default brawler icon pool. */
export async function pickRandomVerificationIconAsync(
  excludeId?: number,
): Promise<VerificationTargetIcon> {
  const icons = await loadBrawlerVerificationIcons();
  const pool = excludeId === undefined ? icons : icons.filter((icon) => icon.id !== excludeId);
  const source = pool.length > 0 ? pool : icons;
  const index = Math.floor(Math.random() * source.length);
  return source[index] ?? DEFAULT_BRAWLER_VERIFICATION_ICONS[0]!;
}

/** Test helper for resetting the in-process metadata cache. */
export function clearVerificationIconCache(): void {
  verificationIconCache = null;
}
