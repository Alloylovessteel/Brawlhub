import { describe, expect, it } from 'vitest';
import { safeNextPath } from './config';
import { deriveRoleGrants } from './roles';

const clubs = [
  { id: 'club-1', tag: '2UG9UGQJY' },
  { id: 'club-2', tag: 'CGJ89PRY' },
];

const emptyRoleMap = { global: { ownerRoleIds: [], adminRoleIds: [] }, clubs: {} };

describe('Discord role derivation', () => {
  it('grants global owner to the Discord guild owner', () => {
    const grants = deriveRoleGrants({
      discordUserId: '111111111111111111',
      guild: { id: 'guild-1', owner: true, roles: [] },
      roleMap: emptyRoleMap,
      ownerRoleIds: [],
      adminRoleIds: [],
      clubs,
    });

    expect(grants).toContainEqual({ scope: 'global', clubId: null, role: 'owner' });
    expect(grants.filter((grant) => grant.scope === 'club')).toHaveLength(2);
  });

  it('only grants elevated club roles from configured Discord role IDs', () => {
    const grants = deriveRoleGrants({
      discordUserId: '111111111111111111',
      guild: {
        id: 'guild-1',
        owner: false,
        roles: ['president-role', 'staff-role'],
      },
      roleMap: {
        global: { ownerRoleIds: [], adminRoleIds: [] },
        clubs: {
          '2UG9UGQJY': {
            presidentRoleIds: ['president-role'],
            staffRoleIds: ['staff-role'],
          },
        },
      },
      ownerRoleIds: [],
      adminRoleIds: [],
      clubs,
    });

    expect(grants).toContainEqual({ scope: 'club', clubId: 'club-1', role: 'owner' });
    expect(grants).toContainEqual({ scope: 'club', clubId: 'club-2', role: 'member' });
  });

  it('does not trust unconfigured Discord roles', () => {
    const grants = deriveRoleGrants({
      discordUserId: '111111111111111111',
      guild: { id: 'guild-1', owner: false, roles: ['random-role'] },
      roleMap: emptyRoleMap,
      ownerRoleIds: [],
      adminRoleIds: [],
      clubs,
    });

    expect(grants.some((grant) => grant.role === 'owner')).toBe(false);
    expect(grants.every((grant) => grant.role === 'member' || grant.scope === 'club')).toBe(true);
  });
});

describe('safeNextPath', () => {
  it('accepts local absolute paths', () => {
    expect(safeNextPath('/dashboard/clubs?tag=2UG9UGQJY')).toBe('/dashboard/clubs?tag=2UG9UGQJY');
  });

  it('rejects external and protocol-relative paths', () => {
    expect(safeNextPath('//evil.example')).toBe('/dashboard');
    expect(safeNextPath('https://evil.example')).toBe('/dashboard');
    expect(safeNextPath('/\\evil')).toBe('/dashboard');
  });
});
