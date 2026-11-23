import { z } from 'zod';

/** Number of Brawl Stars clubs supported in one Discord guild (project capacity, not a per-registration batch size). */
export const SUPPORTED_CLUB_RANGE = { min: 11, max: 20 } as const;

export type Role = 'owner' | 'admin' | 'staff' | 'member';

export type Permission =
  | 'clubs:read'
  | 'clubs:write'
  | 'players:read'
  | 'sync:run'
  | 'members:verify'
  | 'staff:manage'
  | 'competitions:manage'
  | 'blacklists:manage'
  | 'audit:read'
  | 'notifications:send';

/** Single source of truth for permission checkboxes and validation. */
export const ALL_PERMISSIONS = [
  'clubs:read',
  'clubs:write',
  'players:read',
  'sync:run',
  'members:verify',
  'staff:manage',
  'competitions:manage',
  'blacklists:manage',
  'audit:read',
  'notifications:send',
] as const satisfies readonly Permission[];

export const permissionSchema = z.enum(ALL_PERMISSIONS);

export const customRoleNameSchema = z
  .string()
  .trim()
  .min(1, 'Role name is required')
  .max(64, 'Role name must be 64 characters or fewer');

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export function isBuiltinRole(value: unknown): value is Role {
  return (
    value === 'owner' || value === 'admin' || value === 'staff' || value === 'member'
  );
}

const ownerPermissions: readonly Permission[] = [
  'clubs:read',
  'clubs:write',
  'players:read',
  'sync:run',
  'members:verify',
  'staff:manage',
  'competitions:manage',
  'blacklists:manage',
  'audit:read',
  'notifications:send',
];

const adminPermissions: readonly Permission[] = ownerPermissions.filter(
  (permission) => permission !== 'audit:read',
);

const staffPermissions: readonly Permission[] = [
  'clubs:read',
  'players:read',
  'members:verify',
  'competitions:manage',
  'notifications:send',
];

const memberPermissions: readonly Permission[] = ['clubs:read', 'players:read'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ownerPermissions,
  admin: adminPermissions,
  staff: staffPermissions,
  member: memberPermissions,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Guild-scoped role with an explicit permission subset. */
export interface CustomRoleDefinition {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly Permission[];
}

/** A built-in or custom role whose permissions can be evaluated. */
export type EffectiveRole =
  | { readonly kind: 'builtin'; readonly role: Role }
  | { readonly kind: 'custom'; readonly role: CustomRoleDefinition };

export function permissionsForEffectiveRole(role: EffectiveRole): readonly Permission[] {
  return role.kind === 'builtin' ? ROLE_PERMISSIONS[role.role] : role.role.permissions;
}

export function hasAnyPermission(
  roles: readonly EffectiveRole[],
  permission: Permission,
): boolean {
  return roles.some((role) => permissionsForEffectiveRole(role).includes(permission));
}

const BRAWL_TAG_PATTERN = /^[0289CGJLPQRUVY]{3,10}$/;

/**
 * Accepts tags with or without a leading '#', trims surrounding whitespace,
 * uppercases them, and outputs the normalized tag without the '#'.
 */
export const brawlTagSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^#+/, '').toUpperCase())
  .refine((value) => BRAWL_TAG_PATTERN.test(value), {
    message: 'Invalid Brawl Stars tag',
  });

/** Discord snowflakes are 17-20 digit numeric strings. */
export const discordIdSchema = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/, 'Invalid Discord ID');
