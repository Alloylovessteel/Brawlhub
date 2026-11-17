import { z } from 'zod';
import type { GuildMembership } from './roles';

const guildSchema = z
  .object({
    id: z.string(),
    owner: z.boolean().optional(),
    owner_id: z.string().optional(),
    roles: z.array(z.string()).default([]),
  })
  .passthrough();

const guildListSchema = z.array(guildSchema);

export async function fetchDiscordGuilds(accessToken: string): Promise<GuildMembership[]> {
  const response = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Discord guild lookup failed with status ${response.status}`);
  }

  const parsed = guildListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Discord returned malformed guild membership data');
  }

  return parsed.data.map((guild) => ({
    id: guild.id,
    owner: guild.owner ?? false,
    ...(guild.owner_id === undefined ? {} : { ownerId: guild.owner_id }),
    roles: guild.roles,
  }));
}

export function findVerifiedGuild(
  guilds: GuildMembership[],
  guildId: string | undefined,
): GuildMembership | undefined {
  if (guildId === undefined) return undefined;
  return guilds.find((guild) => guild.id === guildId);
}
