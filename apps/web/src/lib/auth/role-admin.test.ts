import { describe, expect, it } from 'vitest';
import { canAdministerRole } from './role-admin';

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
