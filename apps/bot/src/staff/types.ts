import type { Permission, Role } from '@brawlhub/shared';

/** The Discord-linked profile and its effective global role for staff commands. */
export interface StaffActor {
  readonly profileId: string;
  readonly discordUserId: string;
  readonly globalRole: Role | null;
}

/** One stored staff role assignment, with club context resolved separately. */
export interface StaffRoleEntry {
  readonly scope: 'global' | 'club';
  readonly role: Role;
  readonly clubId: string | null;
  readonly clubTag: string | null;
  readonly clubName: string | null;
  readonly grantedAt: string | null;
}

/** A profile and all of its global/club staff assignments. */
export interface StaffMember {
  readonly profileId: string;
  readonly discordUserId: string;
  readonly discordUsername: string | null;
  readonly roles: readonly StaffRoleEntry[];
  readonly highestGlobalRole: Role | null;
  readonly permissions: readonly Permission[];
}

/** Snapshot used by the paginated staff listing. */
export interface StaffListView {
  readonly entries: readonly StaffMember[];
  readonly globalCount: number;
  readonly clubCount: number;
  readonly generatedAt: Date;
}
