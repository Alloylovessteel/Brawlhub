import { describe, expect, it } from 'vitest';
import {
  planLedgerRoleChanges,
  selectLedgerRoleIds,
  selectStaleAssignmentRoleIds,
} from './changes.js';

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

describe('selectStaleAssignmentRoleIds', () => {
  it('closes assignment rows for roles that are no longer desired or held', () => {
    expect(
      selectStaleAssignmentRoleIds({
        activeRoleIds: ['role-verify', 'role-trophy-10k', 'role-trophy-20k'],
        desiredRoleIds: ['role-verify'],
        heldRoleIds: ['role-verify'],
      }),
    ).toEqual(['role-trophy-10k', 'role-trophy-20k']);
  });

  it('keeps desired roles open even when a Discord add has not succeeded yet', () => {
    expect(
      selectStaleAssignmentRoleIds({
        activeRoleIds: ['role-verify', 'role-trophy-20k'],
        desiredRoleIds: ['role-verify', 'role-trophy-20k'],
        heldRoleIds: ['role-verify'],
      }),
    ).toEqual([]);
  });

  it('keeps a still-held non-desired role open until Discord removal succeeds', () => {
    expect(
      selectStaleAssignmentRoleIds({
        activeRoleIds: ['role-trophy-10k'],
        desiredRoleIds: [],
        heldRoleIds: ['role-trophy-10k'],
      }),
    ).toEqual([]);
  });
});
