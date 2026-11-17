import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, brawlTagSchema, discordIdSchema, hasPermission } from './permissions';

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
