import { createTrustedClient } from '@brawlhub/database';
import { recordAdminAudit } from '../admin/service';
import type { AdminActor } from '../admin/types';
import { OVERVIEW_MAX_CLUBS } from './overview/embed';
import { loadClubSummaries } from './service';
import type { ClubSummary } from './types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

export interface ViewTag {
  readonly guildId: string;
  readonly clubId: string;
  readonly addedBy: string | null;
  readonly addedAt: string | null;
}

export type AddViewTagResult =
  | { readonly kind: 'added'; readonly total: number }
  | { readonly kind: 'already-present' }
  | { readonly kind: 'limit-reached'; readonly limit: number }
  | { readonly kind: 'not-found' };

export type RemoveViewTagResult = { readonly kind: 'removed' } | { readonly kind: 'not-found' };

const VIEW_TAG_COLUMNS = 'guild_id, club_id, added_by, added_at';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseViewTag(value: unknown): ViewTag | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const guildId = asString(row['guild_id']);
  const clubId = asString(row['club_id']);
  if (guildId === null || clubId === null) return null;
  return {
    guildId,
    clubId,
    addedBy: asString(row['added_by']),
    addedAt: asString(row['added_at']),
  };
}

function normalizeGuildId(guildId: string): string | null {
  const trimmed = guildId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/** Read a guild's explicit overview club list. Order is stable by add time. */
export async function readViewTags(
  guildId: string,
  options: { readonly db?: DatabaseClient } = {},
): Promise<ViewTag[]> {
  const normalized = normalizeGuildId(guildId);
  if (normalized === null) return [];
  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('guild_view_tags')
    .select(VIEW_TAG_COLUMNS)
    .eq('guild_id', normalized)
    .order('added_at', { ascending: true });
  if (error !== null && error !== undefined) {
    throw new Error(`Read overview clubs failed: ${error.message}`);
  }
  return (data ?? []).map(parseViewTag).filter((tag): tag is ViewTag => tag !== null);
}

/**
 * Add a registered club to the guild's overview. The club must belong to the
 * same guild; the service-role client is used, so the scope check is explicit.
 */
export async function addViewTag(
  input: { readonly guildId: string; readonly clubId: string; readonly actor: AdminActor },
  options: { readonly db?: DatabaseClient } = {},
): Promise<AddViewTagResult> {
  const guildId = normalizeGuildId(input.guildId);
  const clubId = normalizeId(input.clubId);
  if (guildId === null || clubId === null) return { kind: 'not-found' };

  const db = options.db ?? createTrustedClient();
  const [tags, club] = await Promise.all([
    readViewTags(guildId, { db }),
    db.from('clubs').select('id').eq('id', clubId).eq('guild_id', guildId).is('archived_at', null).maybeSingle(),
  ]);
  if (club.error !== null && club.error !== undefined) {
    throw new Error(`Read club failed: ${club.error.message}`);
  }
  if (club.data === null) return { kind: 'not-found' };
  if (tags.some((tag) => tag.clubId === clubId)) return { kind: 'already-present' };
  if (tags.length >= OVERVIEW_MAX_CLUBS) {
    return { kind: 'limit-reached', limit: OVERVIEW_MAX_CLUBS };
  }

  const { error } = await db.from('guild_view_tags').insert({
    guild_id: guildId,
    club_id: clubId,
    added_by: input.actor.profileId,
  });
  if (error !== null && error !== undefined) {
    if (error.code === '23505') return { kind: 'already-present' };
    throw new Error(`Add overview club failed: ${error.message}`);
  }

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'club_view_tag.added',
      targetType: 'club',
      targetId: clubId,
      guildId,
      details: { guildId, clubId },
    },
    { db },
  );

  return { kind: 'added', total: tags.length + 1 };
}

/** Remove a club from the guild's overview. Removing is never a club deletion. */
export async function removeViewTag(
  input: { readonly guildId: string; readonly clubId: string; readonly actor: AdminActor },
  options: { readonly db?: DatabaseClient } = {},
): Promise<RemoveViewTagResult> {
  const guildId = normalizeGuildId(input.guildId);
  const clubId = normalizeId(input.clubId);
  if (guildId === null || clubId === null) return { kind: 'not-found' };

  const db = options.db ?? createTrustedClient();
  const { data, error } = await db
    .from('guild_view_tags')
    .delete()
    .eq('guild_id', guildId)
    .eq('club_id', clubId)
    .select('club_id');
  if (error !== null && error !== undefined) {
    throw new Error(`Remove overview club failed: ${error.message}`);
  }
  if (!(data ?? []).length) return { kind: 'not-found' };

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'club_view_tag.removed',
      targetType: 'club',
      targetId: clubId,
      guildId,
      details: { guildId, clubId },
    },
    { db },
  );

  return { kind: 'removed' };
}

/**
 * Summaries shown in the auto-posted overview. An empty view-tag list means the
 * guild has not chosen a subset yet, so every active registered club is shown.
 */
export async function loadViewTagSummaries(
  guildId: string,
  options: { readonly db?: DatabaseClient } = {},
): Promise<ClubSummary[]> {
  const db = options.db ?? createTrustedClient();
  const summaries = await loadClubSummaries(guildId, db);
  const tags = await readViewTags(guildId, { db });
  if (tags.length === 0) return summaries;
  const allowed = new Set(tags.map((tag) => tag.clubId));
  return summaries.filter((summary) => allowed.has(summary.club.id));
}
