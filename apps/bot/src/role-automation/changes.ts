/**
 * Ledger-only role mutation planning. No Discord or database access lives here:
 * callers pass the roles the member currently holds and the guild's managed-role
 * ledger. Roles outside the ledger are never added or removed.
 */

export interface LedgerRoleChanges {
  readonly addRoleIds: readonly string[];
  readonly removeRoleIds: readonly string[];
  readonly unchangedRoleIds: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

/** Only roles both configured and present in the managed ledger may be mutated. */
export function selectLedgerRoleIds(
  configuredRoleIds: readonly string[],
  managedRoleIds: readonly string[],
): string[] {
  const managed = new Set(managedRoleIds);
  return unique(configuredRoleIds).filter((roleId) => managed.has(roleId));
}

/**
 * Plan the minimal Discord changes for one member. A desired role that is
 * already held counts as unchanged; a held managed role that is no longer
 * desired is removed. Held roles outside the ledger are ignored.
 */
export function planLedgerRoleChanges(input: {
  readonly desiredRoleIds: readonly string[];
  readonly heldRoleIds: readonly string[];
  readonly managedRoleIds: readonly string[];
}): LedgerRoleChanges {
  const managed = new Set(input.managedRoleIds);
  const desired = selectLedgerRoleIds(input.desiredRoleIds, input.managedRoleIds);
  const held = new Set(input.heldRoleIds);

  return {
    addRoleIds: desired.filter((roleId) => !held.has(roleId)),
    removeRoleIds: unique(input.heldRoleIds).filter(
      (roleId) => managed.has(roleId) && !desired.includes(roleId),
    ),
    unchangedRoleIds: desired.filter((roleId) => held.has(roleId)),
  };
}
