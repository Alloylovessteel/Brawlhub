import { z } from 'zod';

/**
 * BrawlAPI supplies static game metadata and asset URLs that the official
 * Brawl Stars API does not expose. Names and live stats still come from the
 * official API; these schemas intentionally keep only metadata/asset fields.
 */

export const brawlApiPlayerIconSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    name2: z.string().optional(),
    imageUrl: z.string().url(),
    imageUrl2: z.string().url().optional(),
    brawler: z.number().int().nonnegative().nullable().optional(),
    requiredExpLevel: z.number().int().nonnegative().optional(),
    requiredTotalTrophies: z.number().int().nonnegative().optional(),
    sortOrder: z.number().int().optional(),
    isReward: z.boolean().optional(),
    isAvailableForOffers: z.boolean().optional(),
  })
  .passthrough();
export type BrawlApiPlayerIcon = z.infer<typeof brawlApiPlayerIconSchema>;

export const brawlApiClubBadgeSchema = z
  .object({
    id: z.number().int().nonnegative(),
    imageUrl: z.string().url(),
  })
  .passthrough();
export type BrawlApiClubBadge = z.infer<typeof brawlApiClubBadgeSchema>;

export const brawlApiIconsResponseSchema = z
  .object({
    player: z.record(z.string(), brawlApiPlayerIconSchema),
    club: z.record(z.string(), brawlApiClubBadgeSchema),
  })
  .passthrough();
export type BrawlApiIconsResponse = z.infer<typeof brawlApiIconsResponseSchema>;

const namedAssetSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    imageUrl: z.string().url().optional(),
    imageUrl2: z.string().url().optional(),
    imageUrl3: z.string().url().optional(),
  })
  .passthrough();

export const brawlApiBrawlerAssetSchema = namedAssetSchema.extend({
  avatarId: z.number().int().nonnegative().optional(),
  hash: z.string().optional(),
  link: z.string().url().optional(),
  class: z.object({ id: z.number().int().optional(), name: z.string() }).passthrough().optional(),
  rarity: z
    .object({
      id: z.number().int().optional(),
      name: z.string(),
      color: z.string().optional(),
    })
    .passthrough()
    .optional(),
  description: z.string().optional(),
});
export type BrawlApiBrawlerAsset = z.infer<typeof brawlApiBrawlerAssetSchema>;

export const brawlApiBrawlersResponseSchema = z
  .object({
    list: z.array(brawlApiBrawlerAssetSchema),
  })
  .passthrough();
export type BrawlApiBrawlersResponse = z.infer<typeof brawlApiBrawlersResponseSchema>;

export const brawlApiGameModeAssetSchema = namedAssetSchema.extend({
  scId: z.number().int().optional(),
  hash: z.string().optional(),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  link: z.string().url().optional(),
});
export type BrawlApiGameModeAsset = z.infer<typeof brawlApiGameModeAssetSchema>;

export const brawlApiGameModesResponseSchema = z
  .object({
    list: z.array(brawlApiGameModeAssetSchema),
  })
  .passthrough();
export type BrawlApiGameModesResponse = z.infer<typeof brawlApiGameModesResponseSchema>;

export const brawlApiMapAssetSchema = namedAssetSchema.extend({
  hash: z.string().optional(),
  link: z.string().url().optional(),
  disabled: z.boolean().optional(),
  new: z.boolean().optional(),
  gameMode: brawlApiGameModeAssetSchema.optional(),
  environment: namedAssetSchema.optional(),
});
export type BrawlApiMapAsset = z.infer<typeof brawlApiMapAssetSchema>;

export const brawlApiMapsResponseSchema = z
  .object({
    list: z.array(brawlApiMapAssetSchema),
  })
  .passthrough();
export type BrawlApiMapsResponse = z.infer<typeof brawlApiMapsResponseSchema>;

/** Static metadata resolved for presentation. Official API remains the data source of truth. */
export interface GameAssetMetadata {
  playerIconUrl: string | null;
  clubBadgeUrl: string | null;
  brawlerImageUrl: string | null;
  mapImageUrl: string | null;
  gameModeImageUrl: string | null;
  gameModeColor: string | null;
}
