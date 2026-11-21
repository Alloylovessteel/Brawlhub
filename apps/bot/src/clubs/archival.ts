import { createTrustedClient } from '@brawlhub/database';
import { recordAdminAudit } from '../admin/service';
import type { AdminActor } from '../admin/types';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

export type ArchiveClubResult =
  | { readonly kind: 'archived' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'already-archived' };

/**
 * Archiving is non-destructive: snapshots, memberships, roles and history stay
 * attached to the club row. Guild scope is enforced on both writes.
 */
export async function archiveGuildClub(
  input: {
    readonly clubId: string;
    readonly guildId: string;
    readonly actor: AdminActor;
    readonly clubTag: string;
    readonly clubName: string;
    readonly now?: Date;
  },
  options: { readonly db?: DatabaseClient } = {},
): Promise<ArchiveClubResult> {
  const db = options.db ?? createTrustedClient();
  const guildId = input.guildId.trim();
  const clubId = input.clubId.trim();
  if (guildId.length === 0 || clubId.length === 0) return { kind: 'not-found' };

  const existing = await db
    .from('clubs')
    .select('id')
    .eq('id', clubId)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (existing.error !== null && existing.error !== undefined) {
    throw new Error(`Read club failed: ${existing.error.message}`);
  }
  if (existing.data === null) return { kind: 'not-found' };

  const archivedAt = (input.now ?? new Date()).toISOString();
  const update = await db
    .from('clubs')
    .update({
      archived_at: archivedAt,
      archived_by: input.actor.profileId,
      archive_reason: 'Archived with /clubs remove',
    })
    .eq('id', clubId)
    .eq('guild_id', guildId)
    .is('archived_at', null)
    .select('id');
  if (update.error !== null && update.error !== undefined) {
    throw new Error(`Archive club failed: ${update.error.message}`);
  }
  if (!(update.data ?? []).length) return { kind: 'already-archived' };

  // The overview should no longer list the archived club.
  await db.from('guild_view_tags').delete().eq('guild_id', guildId).eq('club_id', clubId);

  await recordAdminAudit(
    {
      actor: input.actor,
      action: 'club.archived',
      targetType: 'club',
      targetId: clubId,
      guildId,
      details: { clubTag: input.clubTag, clubName: input.clubName, archivedAt },
    },
    { db },
  );

  return { kind: 'archived' };
}
