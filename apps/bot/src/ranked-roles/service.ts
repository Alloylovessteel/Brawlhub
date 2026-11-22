import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  type Message,
} from 'discord.js';
import { recordAdminAudit, updateGuildSettings, AdminServiceError } from '../admin/service.js';
import type { AdminActor } from '../admin/types.js';
import { parseRankedRank } from '../clubs/calculate.js';
import { asString, record, requireOk } from '../clubs/service.js';
import { getBotConfig } from '../config.js';
import { listGuildVerifiedLinks } from '../verification/service.js';

const logger = createLogger('bot');
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const EMBED_COLOR = 0x5865_f2;

export const RANKED_TIERS = [
  'BRONZE',
  'SILVER',
  'GOLD',
  'DIAMOND',
  'MYTHIC',
  'LEGENDARY',
  'MASTERS',
  'PRO',
] as const;

export type RankedTier = (typeof RANKED_TIERS)[number];
export type RankedRoleMapping = Partial<Record<RankedTier, string>>;

const TIER_COLORS: Readonly<Record<RankedTier, number>> = {
  BRONZE: 0xcd7f32,
  SILVER: 0xc0c0c0,
  GOLD: 0xffd700,
  DIAMOND: 0x00bcd4,
  MYTHIC: 0x9c27b0,
  LEGENDARY: 0xff9800,
  MASTERS: 0xe91e63,
  PRO: 0xf44336,
};

export interface RankedRoleServiceOptions {
  readonly db?: SupabaseClient;
}

export interface GuildRankedRoleState {
  readonly guildId: string;
  readonly mapping: RankedRoleMapping;
  readonly verificationChannelId: string | null;
  readonly verificationMessageId: string | null;
}

export interface RankedRoleLink {
  readonly discordUserId: string;
  readonly playerId: string;
  readonly isMain: boolean;
}

export interface RankedPlayerRank {
  readonly playerId: string;
  readonly rankedRankName: string | null;
}

export interface RankedRolePlan {
  readonly discordUserId: string;
  readonly addRoleIds: readonly string[];
  readonly removeRoleIds: readonly string[];
  readonly tier: RankedTier | null;
  readonly verifiedRoleId: string | null;
}

export interface ApplyRankedRolesResult {
  readonly processed: number;
  readonly membersNotFound: number;
}

function dbFor(options: RankedRoleServiceOptions): SupabaseClient {
  return options.db ?? createTrustedClient();
}

function requireGuildId(guildId: string): string {
  const trimmed = guildId.trim();
  if (!SNOWFLAKE_PATTERN.test(trimmed)) {
    throw new AdminServiceError('invalid_guild', 'A valid Discord guild is required.');
  }
  return trimmed;
}

function parseMapping(value: unknown): RankedRoleMapping {
  const source = record(value);
  if (source === null) return {};
  const mapping: RankedRoleMapping = {};
  for (const tier of RANKED_TIERS) {
    const roleId = asString(source[tier]);
    if (roleId !== null && SNOWFLAKE_PATTERN.test(roleId)) mapping[tier] = roleId;
  }
  return mapping;
}

/** Read every Phase 4 setting for one guild using the trusted database client. */
export async function loadGuildRankedRoleState(
  guildId: string,
  options: RankedRoleServiceOptions = {},
): Promise<GuildRankedRoleState> {
  const parsedGuildId = requireGuildId(guildId);
  const result = await dbFor(options)
    .from('guild_settings')
    .select('guild_id, ranked_role_ids, verification_channel_id, verification_message_id')
    .eq('guild_id', parsedGuildId)
    .maybeSingle();
  requireOk(result.error, 'Read ranked role settings');
  const row = record(result.data);
  return {
    guildId: parsedGuildId,
    mapping: parseMapping(row?.['ranked_role_ids']),
    verificationChannelId: asString(row?.['verification_channel_id']),
    verificationMessageId: asString(row?.['verification_message_id']),
  };
}

/** Persist a guild's ranked role IDs and write an auditable admin event. */
export async function saveGuildRankedRoleMapping(
  input: {
    readonly guildId: string;
    readonly mapping: RankedRoleMapping;
    readonly actor: AdminActor;
    readonly action?: string;
  },
  options: RankedRoleServiceOptions = {},
): Promise<GuildRankedRoleState> {
  const parsedGuildId = requireGuildId(input.guildId);
  const db = dbFor(options);
  const mapping: RankedRoleMapping = {};
  for (const tier of RANKED_TIERS) {
    const roleId = input.mapping[tier];
    if (roleId !== undefined && SNOWFLAKE_PATTERN.test(roleId)) mapping[tier] = roleId;
  }

  const saved = await db.from('guild_settings').upsert(
    {
      guild_id: parsedGuildId,
      ranked_role_ids: mapping,
    },
    { onConflict: 'guild_id' },
  );
  requireOk(saved.error, 'Save ranked role settings');

  await recordAdminAudit(
    {
      actor: input.actor,
      action: input.action ?? 'guild.ranked_roles.updated',
      targetType: 'guild',
      targetId: parsedGuildId,
      guildId: parsedGuildId,
      details: { rankedRoleIds: mapping },
    },
    { db, guildId: parsedGuildId },
  );

  return loadGuildRankedRoleState(parsedGuildId, { db });
}

/** Persist the single verification message posted by `/auto setup`. */
export async function saveGuildVerificationMessage(
  input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly messageId: string;
  },
  options: RankedRoleServiceOptions = {},
): Promise<void> {
  const parsedGuildId = requireGuildId(input.guildId);
  if (!SNOWFLAKE_PATTERN.test(input.channelId) || !SNOWFLAKE_PATTERN.test(input.messageId)) {
    throw new AdminServiceError('invalid_message', 'The verification channel or message is invalid.');
  }
  const saved = await dbFor(options).from('guild_settings').upsert(
    {
      guild_id: parsedGuildId,
      verification_channel_id: input.channelId,
      verification_message_id: input.messageId,
    },
    { onConflict: 'guild_id' },
  );
  requireOk(saved.error, 'Save verification message');
}

/** Map an official `rankedRankName` to a static tier. Unknown ranks are never guessed. */
export function rankedTierFromRankName(rankName: string | null | undefined): RankedTier | null {
  if (typeof rankName !== 'string' || rankName.trim() === '') return null;
  const parsed = parseRankedRank(rankName);
  if (parsed === null) return null;
  const tier = parsed.label.split(' ')[0]?.toUpperCase();
  return RANKED_TIERS.find((candidate) => candidate === tier) ?? null;
}

/** Resolve the configured role for a stored official rank. */
export function resolveRankedRoleId(
  mapping: RankedRoleMapping,
  rankName: string | null | undefined,
): string | null {
  const tier = rankedTierFromRankName(rankName);
  return tier === null ? null : (mapping[tier] ?? null);
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function roleName(tier: RankedTier): string {
  return `FN ${titleCase(tier)}`;
}

/** Reuse a configured role when possible, otherwise create it in the invoking guild. */
export async function ensureRankedRoles(
  guild: Guild,
  mapping: RankedRoleMapping,
): Promise<RankedRoleMapping> {
  await guild.roles.fetch();
  const next: RankedRoleMapping = { ...mapping };

  for (const tier of RANKED_TIERS) {
    const configured = next[tier];
    const existing =
      configured !== undefined
        ? guild.roles.cache.get(configured) ?? null
        : guild.roles.cache.find((role) => role.name === roleName(tier) && !role.managed) ?? null;
    if (existing !== null && !existing.managed) {
      next[tier] = existing.id;
      continue;
    }

    const created = await guild.roles.create({
      name: roleName(tier),
      color: TIER_COLORS[tier],
      hoist: false,
      mentionable: true,
      reason: 'BrawlHub /auto setup ranked roles',
    });
    next[tier] = created.id;
  }

  return next;
}

/** Reuse or create the verified role for this guild. */
export async function ensureVerifiedRole(guild: Guild, configuredRoleId: string | null): Promise<string> {
  await guild.roles.fetch();
  const existing =
    configuredRoleId !== null
      ? guild.roles.cache.get(configuredRoleId) ?? null
      : guild.roles.cache.find((role) => role.name === 'BrawlHub Verified' && !role.managed) ?? null;
  if (existing !== null && !existing.managed) return existing.id;

  const created = await guild.roles.create({
    name: 'BrawlHub Verified',
    color: EMBED_COLOR,
    hoist: false,
    mentionable: true,
    reason: 'BrawlHub /auto setup verification role',
  });
  return created.id;
}

/** Build the verification message posted by `/auto setup`. */
export function buildVerificationMessage(guildId: string): {
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
  readonly allowedMentions: { readonly parse: readonly [] };
} {
  const appUrl = getBotConfig().appUrl;
  const lines = [
    '**1.** Run `/members accounts verify tag:YOURTAG` with your Brawl Stars player tag.',
    '**2.** The bot shows a randomly chosen default brawler icon and its exact ID.',
    '**3.** Set that exact icon in Brawl Stars, then run `/members accounts check`.',
    '**4.** The official Brawl Stars API confirms the match and links the account to you.',
    '',
    'Challenges expire after 10 minutes. Ownership is never guessed from names, tags or profile pictures.',
    'Use `/members accounts list` and `/members accounts set-main tag:TAG` to choose the account used for ranked roles.',
  ];
  if (appUrl !== undefined) lines.push('', `BrawlHub website: ${appUrl}`);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Verify your Brawl Stars account')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'BrawlHub • account-linked roles require verification' });

  const button = new ButtonBuilder()
    .setCustomId(`auto:guide:${guildId}`)
    .setLabel('Verification steps')
    .setStyle(ButtonStyle.Primary);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
    allowedMentions: { parse: [] },
  };
}

async function resolveMessage(
  channel: GuildBasedChannel,
  messageId: string | null,
): Promise<Message | null> {
  if (messageId === null || !('messages' in channel)) return null;
  try {
    return await channel.messages.fetch(messageId);
  } catch {
    return null;
  }
}

/** Post the verification message once, then edit it in place on later setup runs. */
export async function postVerificationMessage(
  guild: Guild,
  channelId: string,
  existingMessageId: string | null,
): Promise<string> {
  const channel = await guild.channels.fetch(channelId);
  if (channel === null || channel.guild.id !== guild.id || !channel.isTextBased()) {
    throw new AdminServiceError('invalid_channel', 'Select a text channel in this server.');
  }

  const payload = buildVerificationMessage(guild.id);
  const existing = await resolveMessage(channel, existingMessageId);
  if (existing !== null && existing.guild?.id === guild.id) {
    await existing.edit(payload);
    return existing.id;
  }

  const posted = await channel.send(payload);
  return posted.id;
}

/** Read stored official ranks for the main accounts in one guild. */
export async function readGuildPlayerRanks(
  playerIds: readonly string[],
  options: RankedRoleServiceOptions = {},
): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(playerIds)].filter((id) => id.trim() !== '');
  const ranks = new Map<string, string | null>();
  if (uniqueIds.length === 0) return ranks;

  const result = await dbFor(options)
    .from('players')
    .select('id, ranked_rank_name')
    .in('id', uniqueIds);
  requireOk(result.error, 'Read stored ranked ranks');
  for (const value of result.data ?? []) {
    const row = record(value);
    const id = asString(row?.['id']);
    if (id === null) continue;
    ranks.set(id, asString(row?.['ranked_rank_name']));
  }
  return ranks;
}

/** Choose the one verified main account per Discord user in this guild. */
export function selectGuildMainLinks(links: readonly RankedRoleLink[]): RankedRoleLink[] {
  const byUser = new Map<string, RankedRoleLink>();
  for (const link of [...links].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
    if (!link.isMain) continue;
    const existing = byUser.get(link.discordUserId);
    if (existing === undefined || link.playerId < existing.playerId) {
      byUser.set(link.discordUserId, link);
    }
  }
  return [...byUser.entries()].map(([discordUserId, link]) => ({ ...link, discordUserId }));
}

/** Plan role changes from verified main accounts and stored official ranks only. */
export function buildRankedRolePlans(
  links: readonly RankedRoleLink[],
  ranks: ReadonlyMap<string, string | null>,
  mapping: RankedRoleMapping,
  verifiedRoleId: string | null,
): RankedRolePlan[] {
  const allRankedRoleIds = RANKED_TIERS.map((tier) => mapping[tier]).filter(
    (roleId): roleId is string => roleId !== undefined,
  );

  return selectGuildMainLinks(links).map((link) => {
    const tier = rankedTierFromRankName(ranks.get(link.playerId));
    const targetRoleId = tier === null ? null : (mapping[tier] ?? null);
    return {
      discordUserId: link.discordUserId,
      tier,
      addRoleIds: targetRoleId === null ? [] : [targetRoleId],
      removeRoleIds: allRankedRoleIds.filter((roleId) => roleId !== targetRoleId),
      verifiedRoleId,
    };
  });
}

/** Apply role plans in the invoking guild. Missing members are skipped, not created. */
export async function applyRankedRolePlans(
  guild: Guild,
  plans: readonly RankedRolePlan[],
): Promise<ApplyRankedRolesResult> {
  let processed = 0;
  let membersNotFound = 0;

  for (const plan of plans) {
    const verifiedRoleId = plan.verifiedRoleId;
    let member;
    try {
      member = await guild.members.fetch(plan.discordUserId);
    } catch {
      membersNotFound += 1;
      continue;
    }

    for (const roleId of plan.removeRoleIds) {
      if (member.roles.cache.has(roleId)) await member.roles.remove(roleId, 'BrawlHub ranked role refresh');
    }
    for (const roleId of plan.addRoleIds) {
      if (!member.roles.cache.has(roleId)) await member.roles.add(roleId, 'BrawlHub ranked role refresh');
    }
    if (verifiedRoleId !== null && !member.roles.cache.has(verifiedRoleId)) {
      await member.roles.add(verifiedRoleId, 'BrawlHub verification role refresh');
    }
    processed += 1;
  }

  return { processed, membersNotFound };
}

/** Which bot-managed roles a member should lose during a full refresh. */
export function selectStaleRoleIds(
  memberRoleIds: readonly string[],
  managedRoleIds: readonly string[],
): string[] {
  const held = new Set(memberRoleIds);
  return [...new Set(managedRoleIds)].filter((roleId) => held.has(roleId));
}

async function removeStaleManagedRoles(
  guild: Guild,
  managedRoleIds: readonly string[],
  keepUserIds: ReadonlySet<string>,
): Promise<number> {
  if (managedRoleIds.length === 0) return 0;
  const members = await guild.members.fetch();
  let cleaned = 0;
  for (const member of members.values()) {
    if (keepUserIds.has(member.id)) continue;
    const staleRoleIds = selectStaleRoleIds([...member.roles.cache.keys()], managedRoleIds);
    if (staleRoleIds.length === 0) continue;
    for (const roleId of staleRoleIds) {
      await member.roles.remove(roleId, 'BrawlHub ranked role refresh');
    }
    cleaned += 1;
  }
  return cleaned;
}

/** Full guild-scoped ranked role refresh used by `/update`. */
export async function refreshGuildRankedRoles(
  guild: Guild,
  actor: AdminActor,
  options: RankedRoleServiceOptions = {},
): Promise<{
  readonly planned: number;
  readonly processed: number;
  readonly membersNotFound: number;
  readonly cleanedMembers: number;
}> {
  const db = dbFor(options);
  const state = await loadGuildRankedRoleState(guild.id, { db });
  const verifiedRoleId = await resolveVerifiedRoleId(guild.id, db);
  const links = await listGuildVerifiedLinks(guild.id, { db });
  const ranks = await readGuildPlayerRanks(
    links.map((link) => link.playerId),
    { db },
  );
  const plans = buildRankedRolePlans(
    links.map((link) => ({
      discordUserId: link.discordUserId,
      playerId: link.playerId,
      isMain: link.isMain,
    })),
    ranks,
    state.mapping,
    verifiedRoleId,
  );
  const result = await applyRankedRolePlans(guild, plans);
  const managedRoleIds = [
    ...RANKED_TIERS.map((tier) => state.mapping[tier]).filter(
      (roleId): roleId is string => roleId !== undefined,
    ),
    ...(verifiedRoleId === null ? [] : [verifiedRoleId]),
  ];
  const cleanedMembers = await removeStaleManagedRoles(
    guild,
    managedRoleIds,
    new Set(plans.map((plan) => plan.discordUserId)),
  );

  await recordAdminAudit(
    {
      actor,
      action: 'guild.ranked_roles.refreshed',
      targetType: 'guild',
      targetId: guild.id,
      guildId: guild.id,
      details: {
        planned: plans.length,
        processed: result.processed,
        membersNotFound: result.membersNotFound,
        cleanedMembers,
      },
    },
    { db, guildId: guild.id },
  );

  return { planned: plans.length, ...result, cleanedMembers };
}

async function resolveVerifiedRoleId(guildId: string, db: SupabaseClient): Promise<string | null> {
  const result = await db
    .from('guild_settings')
    .select('verified_role_id')
    .eq('guild_id', guildId)
    .maybeSingle();
  requireOk(result.error, 'Read verified role');
  return asString(record(result.data)?.['verified_role_id']);
}

/** Refresh one Discord user's role from their verified main account in this guild. */
export async function refreshMemberRankedRole(
  guild: Guild,
  discordUserId: string,
  options: RankedRoleServiceOptions = {},
): Promise<{ readonly kind: 'ok' | 'not-verified' | 'not-member'; readonly tier: RankedTier | null }> {
  const db = dbFor(options);
  const state = await loadGuildRankedRoleState(guild.id, { db });
  const verifiedRoleId = await resolveVerifiedRoleId(guild.id, db);
  const links = await listGuildVerifiedLinks(guild.id, { db });
  const link = links.find(
    (candidate) => candidate.discordUserId === discordUserId && candidate.isMain,
  );
  if (link === undefined) return { kind: 'not-verified', tier: null };

  const ranks = await readGuildPlayerRanks([link.playerId], { db });
  const plans = buildRankedRolePlans(
    [{ discordUserId, playerId: link.playerId, isMain: true }],
    ranks,
    state.mapping,
    verifiedRoleId,
  );
  const result = await applyRankedRolePlans(guild, plans);
  return {
    kind: result.processed === 0 ? 'not-member' : 'ok',
    tier: plans[0]?.tier ?? null,
  };
}

/** Create or reuse every Phase 4 role, then post/edit the verification message. */
export async function setupGuildAutomation(
  guild: Guild,
  actor: AdminActor,
  channelId: string,
  options: RankedRoleServiceOptions = {},
): Promise<GuildRankedRoleState> {
  const db = dbFor(options);
  const current = await loadGuildRankedRoleState(guild.id, { db });
  const settings = await db
    .from('guild_settings')
    .select('verified_role_id')
    .eq('guild_id', guild.id)
    .maybeSingle();
  requireOk(settings.error, 'Read verified role for setup');

  const verifiedRoleId = await ensureVerifiedRole(guild, asString(record(settings.data)?.['verified_role_id']));
  await updateGuildSettings(
    { actor, guildId: guild.id, field: 'verifiedRoleId', value: verifiedRoleId },
    { db, guildId: guild.id },
  );

  const mapping = await ensureRankedRoles(guild, current.mapping);
  const saved = await saveGuildRankedRoleMapping(
    {
      guildId: guild.id,
      mapping,
      actor,
      action: 'guild.automation.setup',
    },
    { db },
  );

  const messageId = await postVerificationMessage(
    guild,
    channelId,
    current.verificationMessageId,
  );
  await saveGuildVerificationMessage(
    { guildId: guild.id, channelId, messageId },
    { db },
  );

  logger.info('Phase 4 automation set up', { guildId: guild.id, channelId, messageId });
  return { ...saved, verificationChannelId: channelId, verificationMessageId: messageId };
}
