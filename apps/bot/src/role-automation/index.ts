export {
  reconcileAllConfiguredRoles,
  reconcileGuildRoles,
  reconcileGuildRolesForPlayer,
  setRoleAutomationClient,
  setupGuildAutoRoles,
} from './service.js';
export type {
  AutoRoleConfig,
  AutoRoleSetupSummary,
  GuildRoleReconcileResult,
  MemberHookResult,
  ReconcileAllRolesResult,
  ReconcileCounts,
  RoleAutomationOptions,
} from './service.js';
export {
  computeDesiredTierKeys,
  countProfileBrawlers,
  DEFAULT_TIER_KEYS,
  ROLE_KINDS,
  ROLE_KIND_LABELS,
} from './tiers.js';
export type { RoleKind, TierSource } from './tiers.js';
export { planLedgerRoleChanges, selectLedgerRoleIds } from './changes.js';
