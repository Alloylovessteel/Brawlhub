import { z } from 'zod';

export const clubMemberRoleSchema = z.enum([
  'notMember',
  'rookie',
  'member',
  'senior',
  'vicePresident',
  'president',
]);
export type ClubMemberRole = z.infer<typeof clubMemberRoleSchema>;

export const clubMemberSchema = z
  .object({
    tag: z.string().min(1),
    name: z.string(),
    nameColor: z.string().optional(),
    trophies: z.number().int().nonnegative(),
    role: clubMemberRoleSchema,
    icon: z.object({ id: z.number().int() }).passthrough().optional(),
  })
  .passthrough();
export type ClubMember = z.infer<typeof clubMemberSchema>;

export const clubMembersResponseSchema = z
  .object({
    items: z.array(clubMemberSchema),
    paging: z.unknown().optional(),
  })
  .passthrough();
export type ClubMembersResponse = z.infer<typeof clubMembersResponseSchema>;

export const clubSummarySchema = z
  .object({
    tag: z.string().min(1),
    name: z.string(),
  })
  .passthrough();
export type ClubSummary = z.infer<typeof clubSummarySchema>;

export const clubSchema = z
  .object({
    tag: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    type: z.string().optional(),
    badgeId: z.number().int().nonnegative().optional(),
    trophies: z.number().int().nonnegative(),
    requiredTrophies: z.number().int().nonnegative().optional(),
    members: z.array(clubMemberSchema).optional(),
  })
  .passthrough();
export type Club = z.infer<typeof clubSchema>;

export const brawlerAccessorySchema = z
  .object({
    id: z.number().int().optional(),
    name: z.string().optional(),
    level: z.number().int().optional(),
  })
  .passthrough();

export const playerBrawlerSchema = z
  .object({
    id: z.number().int().optional(),
    name: z.string(),
    power: z.number().int().nonnegative().optional(),
    rank: z.number().int().nonnegative().optional(),
    trophies: z.number().int().nonnegative(),
    highestTrophies: z.number().int().nonnegative().optional(),
    prestigeLevel: z.number().int().nonnegative().optional(),
    currentWinStreak: z.number().int().nonnegative().optional(),
    maxWinStreak: z.number().int().nonnegative().optional(),
    skin: z.object({ id: z.number().int(), name: z.string() }).passthrough().optional(),
    gadgets: z.array(brawlerAccessorySchema).optional(),
    gears: z.array(brawlerAccessorySchema).optional(),
    starPowers: z.array(brawlerAccessorySchema).optional(),
    hyperCharges: z.array(brawlerAccessorySchema).optional(),
    buffies: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();
export type PlayerBrawler = z.infer<typeof playerBrawlerSchema>;
/** @deprecated Use PlayerBrawler; kept for compatibility. */
export type Brawler = PlayerBrawler;

export const playerSchema = z
  .object({
    tag: z.string().min(1),
    name: z.string(),
    nameColor: z.union([z.string(), z.number().int()]).optional(),
    icon: z.object({ id: z.number().int() }).passthrough().optional(),
    trophies: z.number().int().nonnegative(),
    /** Official API uses highestTrophies; older responses used highscore. */
    highestTrophies: z.number().int().nonnegative().optional(),
    highscore: z.number().int().nonnegative().optional(),
    totalPrestigeLevel: z.number().int().nonnegative().optional(),
    fame: z.number().int().nonnegative().optional(),
    fameTierName: z.string().optional(),
    expLevel: z.number().int().nonnegative().optional(),
    expPoints: z.number().int().nonnegative().optional(),
    isQualifiedFromChampionshipChallenge: z.boolean().optional(),
    '3vs3Victories': z.number().int().nonnegative().optional(),
    soloVictories: z.number().int().nonnegative().optional(),
    duoVictories: z.number().int().nonnegative().optional(),
    bestRoboRumbleTime: z.number().int().nonnegative().optional(),
    bestTimeAsBigBrawler: z.number().int().nonnegative().optional(),
    rankedSeasonId: z.number().int().optional(),
    rankedRank: z.number().int().optional(),
    rankedRankName: z.string().optional(),
    rankedElo: z.number().int().optional(),
    highestSeasonRankedRank: z.number().int().optional(),
    highestSeasonRankedRankName: z.string().optional(),
    highestSeasonRankedElo: z.number().int().optional(),
    highestAllTimeRankedRank: z.number().int().optional(),
    highestAllTimeRankedRankName: z.string().optional(),
    highestAllTimeRankedElo: z.number().int().optional(),
    club: clubSummarySchema.optional(),
    soloRank: z.number().int().nonnegative().optional(),
    teamRank: z.number().int().nonnegative().optional(),
    brawlers: z.array(playerBrawlerSchema).optional(),
  })
  .passthrough();
export type Player = z.infer<typeof playerSchema>;

export const battleEventSchema = z
  .object({
    id: z.number().int().optional(),
    mode: z.string().optional(),
    modeId: z.number().int().optional(),
    map: z.string().optional(),
  })
  .passthrough();

export const battleBrawlerSchema = z
  .object({
    id: z.number().int().optional(),
    name: z.string().optional(),
    power: z.number().int().optional(),
    trophies: z.number().int().optional(),
  })
  .passthrough();

export const battleParticipantStatsSchema = z
  .object({
    kills: z.number().int().optional(),
    deaths: z.number().int().optional(),
    damageDealt: z.number().int().optional(),
    healing: z.number().int().optional(),
    damageTaken: z.number().int().optional(),
    modeStat: z
      .object({
        type: z.string().optional(),
        value: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const battleParticipantSchema = z
  .object({
    tag: z.string().optional(),
    name: z.string().optional(),
    brawler: battleBrawlerSchema.optional(),
    stats: battleParticipantStatsSchema.optional(),
  })
  .passthrough();

export const battleSchema = z
  .object({
    mode: z.string().optional(),
    type: z.string().optional(),
    result: z.string().optional(),
    duration: z.number().int().nonnegative().optional(),
    trophyChange: z.number().int().optional(),
    rank: z.number().int().positive().optional(),
    starPlayer: battleParticipantSchema.nullable().optional(),
    teams: z.array(z.array(battleParticipantSchema)).optional(),
    players: z.array(battleParticipantSchema).optional(),
  })
  .passthrough();

export const battleLogItemSchema = z
  .object({
    battleTime: z.string().min(1),
    event: battleEventSchema.optional(),
    battle: battleSchema.optional(),
  })
  .passthrough();

export const battleLogResponseSchema = z
  .object({
    items: z.array(battleLogItemSchema),
    paging: z.unknown().optional(),
  })
  .passthrough();
export type BattleLogItem = z.infer<typeof battleLogItemSchema>;
export type BattleLogResponse = z.infer<typeof battleLogResponseSchema>;

/** Official static brawler catalog (`GET /brawlers`). */
export const brawlerCatalogItemSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    starPowers: z.array(brawlerAccessorySchema).optional(),
    gadgets: z.array(brawlerAccessorySchema).optional(),
    gears: z.array(brawlerAccessorySchema).optional(),
    hyperCharges: z.array(brawlerAccessorySchema).optional(),
  })
  .passthrough();
export type BrawlerCatalogItem = z.infer<typeof brawlerCatalogItemSchema>;

export const brawlerCatalogResponseSchema = z
  .object({
    items: z.array(brawlerCatalogItemSchema),
    paging: z.unknown().optional(),
  })
  .passthrough();
export type BrawlerCatalogResponse = z.infer<typeof brawlerCatalogResponseSchema>;

/** Official live event rotation (`GET /events/rotation`). */
export const eventRotationEventSchema = z
  .object({
    id: z.number().int().optional(),
    mode: z.string().optional(),
    modeId: z.number().int().optional(),
    map: z.string().optional(),
  })
  .passthrough();

export const eventRotationSlotSchema = z
  .object({
    /** Official format: `20261119T080000.000Z`. */
    startTime: z.string(),
    /** Official format: `20261120T080000.000Z`. */
    endTime: z.string(),
    slotId: z.number().int().nonnegative(),
    event: eventRotationEventSchema.optional(),
  })
  .passthrough();
export type EventRotationSlot = z.infer<typeof eventRotationSlotSchema>;
export const eventRotationResponseSchema = z.array(eventRotationSlotSchema);
