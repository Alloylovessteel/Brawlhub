import { describe, expect, it } from 'vitest';
import { canAdministerRole, canAdministerRoleChange } from './role-admin';

describe('canAdministerRole', () => {
  it('lets the Server Owner assign global and club roles', () => {
    expect(canAdministerRole({ globalRole: 'owner' }, 'global', 'admin')).toBe(true);
    expect(canAdministerRole({ globalRole: 'owner' }, 'club', 'owner')).toBe(true);
  });

  it('prevents administrators from assigning global roles or club presidents', () => {
    expect(canAdministerRole({ globalRole: 'admin' }, 'global', 'admin')).toBe(false);
    expect(canAdministerRole({ globalRole: 'admin' }, 'club', 'owner')).toBe(false);
    expect(canAdministerRole({ globalRole: 'admin' }, 'club', 'staff')).toBe(true);
  });

  it('only lets club presidents assign staff/member roles inside their own club', () => {
    expect(canAdministerRole({ globalRole: null, clubRole: 'owner' }, 'club', 'staff')).toBe(true);
    expect(canAdministerRole({ globalRole: null, clubRole: 'owner' }, 'club', 'owner')).toBe(false);
    expect(canAdministerRole({ globalRole: null, clubRole: 'owner' }, 'global', 'staff')).toBe(false);
    expect(canAdministerRole({ globalRole: null, clubRole: 'staff' }, 'club', 'member')).toBe(false);
  });
});

describe('canAdministerRoleChange', () => {
  it('checks the target\'s existing roles as well as the requested role', () => {
    const globalAdmin = { globalRole: 'admin' as const };
    expect(canAdministerRoleChange(globalAdmin, 'club', 'member', ['staff'])).toBe(true);
    expect(canAdministerRoleChange(globalAdmin, 'club', 'member', ['owner'])).toBe(false);
    expect(canAdministerRoleChange({ globalRole: 'owner' }, 'global', 'admin', ['owner'])).toBe(true);
  });

  it('allows an empty target when the requested role itself is permitted', () => {
    expect(canAdministerRoleChange({ globalRole: 'owner' }, 'global', 'admin', [])).toBe(true);
    expect(canAdministerRoleChange({ globalRole: 'admin' }, 'global', 'admin', [])).toBe(false);
  });
});
