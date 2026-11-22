import { describe, expect, it } from 'vitest';
import { planLedgerRoleChanges, selectLedgerRoleIds } from './changes.js';

const LEDGER = ['role-verify', 'role-trophy-10k', 'role-trophy-20k'];

describe('ledger-only role changes', () => {
  it('never selects a role that is not in the managed ledger', () => {
    expect(selectLedgerRoleIds(['role-verify', 'role-other'], LEDGER)).toEqual(['role-verify']);
  });

  it('adds desired ledger roles that are missing', () => {
    expect(
      planLedgerRoleChanges({
        desiredRoleIds: ['role-verify'],
        heldRoleIds: [],
        managedRoleIds: LEDGER,
      }),
    ).toEqual({
      addRoleIds: ['role-verify'],
      removeRoleIds: [],
      unchangedRoleIds: [],
    });
  });

  it('removes only held managed roles that are no longer desired', () => {
    expect(
      planLedgerRoleChanges({
        desiredRoleIds: ['role-trophy-20k'],
        heldRoleIds: ['role-trophy-10k', 'role-trophy-20k', 'role-unmanaged'],
        managedRoleIds: LEDGER,
      }),
    ).toEqual({
      addRoleIds: [],
      removeRoleIds: ['role-trophy-10k'],
      unchangedRoleIds: ['role-trophy-20k'],
    });
  });

  it('ignores desired roles outside the ledger and keeps unmanaged roles untouched', () => {
    expect(
      planLedgerRoleChanges({
        desiredRoleIds: ['role-manual', 'role-verify'],
        heldRoleIds: ['role-unmanaged'],
        managedRoleIds: LEDGER,
      }),
    ).toEqual({
      addRoleIds: ['role-verify'],
      removeRoleIds: [],
      unchangedRoleIds: [],
    });
  });

  it('adds nothing when every desired ledger role is already held', () => {
    expect(
      planLedgerRoleChanges({
        desiredRoleIds: ['role-verify', 'role-trophy-20k'],
        heldRoleIds: ['role-verify', 'role-trophy-20k'],
        managedRoleIds: LEDGER,
      }),
    ).toEqual({
      addRoleIds: [],
      removeRoleIds: [],
      unchangedRoleIds: ['role-verify', 'role-trophy-20k'],
    });
  });
});
