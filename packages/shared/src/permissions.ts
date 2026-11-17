import { z } from 'zod';

/** Official Brawl Stars club trophies are validated against this inclusive range. */
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
