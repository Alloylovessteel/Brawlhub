import type { CommandComponentInteraction } from '../../discord/interactions.js';
import { replyUnknownComponent } from '../../discord/errors.js';
import { handleClubComponent } from '../club.js';
import { handleClubsComponent } from '../clubs.js';
import { handleClubMembersComponent } from '../club-members.js';
import { handleClubLeaderboardComponent } from '../club-leaderboard.js';
import { handleClubLogComponent } from '../club-log.js';
import { handleClubHistoryComponent } from '../club-history.js';
import { handleClubOverviewComponent } from '../club-overview.js';
import { handleClubLogsComponent } from '../clublogs.js';
import { handleEventsComponent } from '../events.js';
import { handleMeComponent } from '../me-components.js';
import { handlePlayerHistoryComponent } from '../player-history.js';
import { handlePlayerBattlesComponent } from '../player-battles.js';
import { handleBrawlersComponent } from '../brawlers.js';
import { handlePlayerClubsComponent } from '../player-clubs.js';
import { handleLeaderboardComponent } from '../leaderboard.js';
import { handleCompetitionComponent } from '../competition.js';
import { handleMembersComponent } from '../members.js';
import {
  handleUnverifyOneComponent,
  handleUnverifyAllComponent,
} from '../admin-identity.js';
import { handleDeleteMeComponent } from '../delete-me.js';
import { handleMemberHistoryComponent } from '../member-history.js';
import { handleMemberSearchComponent } from '../member-search.js';
import { handleStaffComponent } from '../staff.js';
import { handleRegisterClubComponent } from '../register-club.js';
import { handleSettingsComponent } from '../settings.js';
import { handleAuditComponent } from '../audit.js';
import { handleRemoveClubComponent } from '../remove-club.js';
import { handleHelpComponent } from '../help.js';
import { handleFnComponent } from '../fn.js';
import { handleAutoComponent } from '../auto.js';
import { handleUpdateComponent } from '../update.js';

export type ComponentHandler = (interaction: CommandComponentInteraction) => Promise<void>;

/** Original custom-ID prefix -> original component handler. Never rewrite IDs. */
export type ComponentHandlers = Readonly<Record<string, ComponentHandler>>;

export const COMPONENT_HANDLERS: ComponentHandlers = {
  club: handleClubComponent,
  clubs: handleClubsComponent,
  'club-members': handleClubMembersComponent,
  'club-leaderboard': handleClubLeaderboardComponent,
  'club-log': handleClubLogComponent,
  'club-history': handleClubHistoryComponent,
  'club-overview': handleClubOverviewComponent,
  clublogs: handleClubLogsComponent,
  events: handleEventsComponent,
  me: handleMeComponent,
  'player-history': handlePlayerHistoryComponent,
  'player-battles': handlePlayerBattlesComponent,
  brawlers: handleBrawlersComponent,
  'player-clubs': handlePlayerClubsComponent,
  leaderboard: handleLeaderboardComponent,
  competition: handleCompetitionComponent,
  members: handleMembersComponent,
  'unverify-one': handleUnverifyOneComponent,
  'unverify-all': handleUnverifyAllComponent,
  'delete-me': handleDeleteMeComponent,
  'member-history': handleMemberHistoryComponent,
  'member-search': handleMemberSearchComponent,
  staff: handleStaffComponent,
  'register-club': handleRegisterClubComponent,
  settings: handleSettingsComponent,
  audit: handleAuditComponent,
  'remove-club': handleRemoveClubComponent,
  help: handleHelpComponent,
  fn: handleFnComponent,
  auto: handleAutoComponent,
  update: handleUpdateComponent,
};

/**
 * Retired top-level command prefix -> Option 3 anchor. This keeps buttons and
 * select menus from older messages deliverable after the registry is reduced.
 */
export const LEGACY_COMPONENT_ALIASES: Readonly<Record<string, string>> = {
  club: 'clubs',
  'club-members': 'clubs',
  'club-leaderboard': 'clubs',
  'club-log': 'clubs',
  'club-history': 'clubs',
  'club-compare': 'clubs',
  view: 'clubs',
  'club-overview': 'clubs',
  clublogs: 'clubs',
  'register-club': 'clubs',
  'remove-club': 'clubs',
  'player-history': 'player',
  'player-battles': 'player',
  'player-clubs': 'player',
  'player-compare': 'player',
  brawler: 'brawlers',
  account: 'members',
  verify: 'members',
  'unverify-one': 'members',
  'unverify-all': 'members',
  'delete-me': 'members',
  'member-history': 'members',
  'member-search': 'members',
  info: 'help',
  ping: 'help',
};

/** Resolves a legacy custom-ID prefix to the active Option 3 anchor name. */
export function resolveLegacyComponentCommand(prefix: string): string {
  return LEGACY_COMPONENT_ALIASES[prefix] ?? prefix;
}

/** Whether the original prefix still has a live component handler. */
export function hasComponentHandler(prefix: string): boolean {
  return COMPONENT_HANDLERS[prefix] !== undefined;
}

/**
 * Build a composite-anchor handler. The injected record keeps this dispatcher
 * testable without changing the original custom IDs or their handlers.
 */
export function createCompositeComponentHandler(
  handlers: ComponentHandlers = COMPONENT_HANDLERS,
): ComponentHandler {
  return async (interaction) => {
    const [prefix] = interaction.customId.split(':');
    const handler = prefix === undefined ? undefined : handlers[prefix];
    if (handler === undefined) {
      // Unknown/retired prefixes used to disappear silently; give explicit,
      // ephemeral feedback when the interaction can still be answered.
      await replyUnknownComponent(interaction);
      return;
    }
    await handler(interaction);
  };
}

/**
 * Component handler for composite anchors. It dispatches on the untouched
 * custom-ID prefix so original parsers, nonces and permission checks continue
 * to run unchanged.
 */
export const handleCompositeComponent = createCompositeComponentHandler();
