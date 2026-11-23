import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  brawlTagSchema,
  customRoleNameSchema,
  discordIdSchema,
  hasAnyPermission,
  hasPermission,
  isBuiltinRole,
  isPermission,
  permissionSchema,
} from './permissions';

describe('hasPermission', () => {
  it('grants owners every permission', () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(hasPermission('owner', permission)).toBe(true);
      }
    }
  });

  it('applies a sensible role hierarchy', () => {
    expect(hasPermission('admin', 'sync:run')).toBe(true);
    expect(hasPermission('admin', 'staff:manage')).toBe(true);
    expect(hasPermission('admin', 'audit:read')).toBe(false);

    expect(hasPermission('staff', 'members:verify')).toBe(true);
    expect(hasPermission('staff', 'competitions:manage')).toBe(true);
    expect(hasPermission('staff', 'staff:manage')).toBe(false);
    expect(hasPermission('staff', 'blacklists:manage')).toBe(false);

    expect(hasPermission('member', 'clubs:read')).toBe(true);
    expect(hasPermission('member', 'players:read')).toBe(true);
    expect(hasPermission('member', 'clubs:write')).toBe(false);
  });
});

describe('custom role helpers', () => {
  it('covers every built-in permission exactly once', () => {
    const builtInPermissions = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect([...builtInPermissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('validates the 10 permissions and trims custom role names', () => {
    expect(permissionSchema.safeParse('audit:read').success).toBe(true);
    expect(permissionSchema.safeParse('made:up').success).toBe(false);
    expect(isPermission('sync:run')).toBe(true);
    expect(isPermission('sync:ALL')).toBe(false);
    expect(customRoleNameSchema.parse('  Event lead  ')).toBe('Event lead');
    expect(customRoleNameSchema.safeParse('').success).toBe(false);
  });

  it('unions built-in and custom role permissions without widening the stored role', () => {
    expect(isBuiltinRole('staff')).toBe(true);
    expect(isBuiltinRole('event-lead')).toBe(false);
    expect(
      hasAnyPermission(
        [
          { kind: 'builtin', role: 'member' },
          {
            kind: 'custom',
            role: {
              id: 'role-id',
              guildId: 'guild-id',
              name: 'Event lead',
              description: null,
              permissions: ['sync:run'],
            },
          },
        ],
        'sync:run',
      ),
    ).toBe(true);
    expect(
      hasAnyPermission(
        [
          {
            kind: 'custom',
            role: {
              id: 'role-id',
              guildId: 'guild-id',
              name: 'Event lead',
              description: null,
              permissions: ['clubs:read'],
            },
          },
        ],
        'audit:read',
      ),
    ).toBe(false);
  });
});

describe('brawlTagSchema', () => {
  it('normalizes tags by trimming hashes and uppercasing', () => {
    expect(brawlTagSchema.parse('#g2p9')).toBe('G2P9');
    expect(brawlTagSchema.parse('  ##2c0y  ')).toBe('2C0Y');
    expect(brawlTagSchema.parse('2C0Y')).toBe('2C0Y');
  });

  it('rejects invalid tags', () => {
    expect(brawlTagSchema.safeParse('#123').success).toBe(false);
    expect(brawlTagSchema.safeParse('#').success).toBe(false);
    expect(brawlTagSchema.safeParse('ABCDEFGH').success).toBe(false);
    expect(brawlTagSchema.safeParse('2C0Y2C0Y2CY').success).toBe(false);
  });
});

describe('discordIdSchema', () => {
  it('accepts snowflakes and rejects other values', () => {
    expect(discordIdSchema.parse('123456789012345678')).toBe('123456789012345678');
    expect(discordIdSchema.safeParse('1234').success).toBe(false);
    expect(discordIdSchema.parse('12345678901234567890')).toBe('12345678901234567890');
    expect(discordIdSchema.safeParse('123456789012345678901').success).toBe(false);
    expect(discordIdSchema.safeParse('not-a-snowflake').success).toBe(false);
  });
});
