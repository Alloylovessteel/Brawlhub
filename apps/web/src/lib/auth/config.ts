import { brawlTagSchema, discordIdSchema } from '@brawlhub/shared';
import { z } from 'zod';

const snowflakeListSchema = z
  .string()
  .trim()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(discordIdSchema));

const clubRoleSchema = z.object({
  presidentRoleIds: z.array(discordIdSchema).default([]),
  staffRoleIds: z.array(discordIdSchema).default([]),
});

export const discordRoleMapSchema = z.object({
  global: z
    .object({
      ownerRoleIds: z.array(discordIdSchema).default([]),
      adminRoleIds: z.array(discordIdSchema).default([]),
    })
    .default({ ownerRoleIds: [], adminRoleIds: [] }),
  clubs: z.record(z.string(), clubRoleSchema).default({}),
});

export type DiscordRoleMap = z.infer<typeof discordRoleMapSchema>;

function parseRoleMap(raw: string | undefined): DiscordRoleMap {
  if (raw === undefined || raw.trim().length === 0) {
    return { global: { ownerRoleIds: [], adminRoleIds: [] }, clubs: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DISCORD_ROLE_MAP must be valid JSON');
  }

  const result = discordRoleMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`DISCORD_ROLE_MAP is invalid: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }

  const clubs: DiscordRoleMap['clubs'] = {};
  for (const [rawTag, roles] of Object.entries(result.data.clubs)) {
    const tag = brawlTagSchema.safeParse(rawTag);
    if (!tag.success) {
      throw new Error(`DISCORD_ROLE_MAP contains an invalid club tag: ${rawTag}`);
    }
    clubs[tag.data] = roles;
  }

  return { global: result.data.global, clubs };
}

export function getDiscordRoleMap(): DiscordRoleMap {
  return parseRoleMap(process.env.DISCORD_ROLE_MAP);
}

export function getOwnerRoleIds(): string[] {
  return snowflakeListSchema.parse(process.env.DISCORD_OWNER_ROLE_IDS ?? '');
}

export function getAdminRoleIds(): string[] {
  return snowflakeListSchema.parse(process.env.DISCORD_ADMIN_ROLE_IDS ?? '');
}

export function getGuildId(): string | undefined {
  const raw = process.env.DISCORD_GUILD_ID?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

/** Accepts only local absolute paths, preventing open redirects after login. */
export function safeNextPath(raw: string | null | undefined): string {
  if (
    raw === null ||
    raw === undefined ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    return '/dashboard';
  }
  return raw;
}
