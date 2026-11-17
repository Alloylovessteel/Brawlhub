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

export const clubMemberSchema = z.object({
  tag: z.string().min(1),
  name: z.string(),
  trophies: z.number().int().nonnegative(),
  role: clubMemberRoleSchema,
});
export type ClubMember = z.infer<typeof clubMemberSchema>;

export const clubMembersResponseSchema = z.object({
  items: z.array(clubMemberSchema),
});
export type ClubMembersResponse = z.infer<typeof clubMembersResponseSchema>;

export const clubSummarySchema = z.object({
  tag: z.string().min(1),
  name: z.string(),
});
export type ClubSummary = z.infer<typeof clubSummarySchema>;

export const clubSchema = z.object({
  tag: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  trophies: z.number().int().nonnegative(),
  requiredTrophies: z.number().int().nonnegative().optional(),
  members: z.array(clubMemberSchema).optional(),
});
export type Club = z.infer<typeof clubSchema>;

export const brawlerSchema = z.object({
  name: z.string(),
  trophies: z.number().int().nonnegative(),
});
export type Brawler = z.infer<typeof brawlerSchema>;

export const playerSchema = z.object({
  tag: z.string().min(1),
  name: z.string(),
  nameColor: z.number().int().optional(),
  trophies: z.number().int().nonnegative(),
  highscore: z.number().int().nonnegative().optional(),
  expLevel: z.number().int().nonnegative().optional(),
  expPoints: z.number().int().nonnegative().optional(),
  club: clubSummarySchema.optional(),
  soloRank: z.number().int().nonnegative().optional(),
  teamRank: z.number().int().nonnegative().optional(),
  brawlers: z.array(brawlerSchema).optional(),
});
export type Player = z.infer<typeof playerSchema>;
