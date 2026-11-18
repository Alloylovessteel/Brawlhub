export interface HelpCommandEntry {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly permission?: string;
}

export interface HelpCategory {
  readonly name: string;
  readonly entries: readonly HelpCommandEntry[];
}

/**
 * Curated directory of commands that are registered in the current bot build.
 * Tests verify this list against the active command registry so unavailable or
 * pending commands cannot be advertised accidentally.
 */
export const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    name: 'Club',
    entries: [
      {
        name: 'club',
        usage: '/club tag:2UG9UGQJY',
        description: 'Show detailed club information with live data when available.',
      },
      {
        name: 'clubs',
        usage: '/clubs',
        description: 'Browse the registered clubs.',
      },
      {
        name: 'club-members',
        usage: '/club-members tag:2UG9UGQJY',
        description: 'List tracked members of a registered club.',
      },
      {
        name: 'club-leaderboard',
        usage: '/club-leaderboard',
        description: 'Rank registered clubs by trophies.',
      },
      {
        name: 'club-history',
        usage: '/club-history tag:2UG9UGQJY',
        description: 'Show stored history for a registered club.',
      },
      {
        name: 'club-compare',
        usage: '/club-compare first:2UG9UGQJY second:G2P9',
        description: 'Compare two registered clubs using stored data.',
      },
    ],
  },
  {
    name: 'Player',
    entries: [
      {
        name: 'player',
        usage: '/player tag:PLAYERTAG',
        description: 'Show a player profile and club context.',
      },
      {
        name: 'player-history',
        usage: '/player-history tag:PLAYERTAG',
        description: 'Show stored trophy and club history for a player.',
      },
      {
        name: 'player-clubs',
        usage: '/player-clubs tag:PLAYERTAG',
        description: 'Show the club history recorded for a player.',
      },
      {
        name: 'player-compare',
        usage: '/player-compare first:PLAYERTAG second:OTHERTAG',
        description: 'Compare two players over a selected history period.',
      },
    ],
  },
  {
    name: 'Leaderboard',
    entries: [
      {
        name: 'leaderboard',
        usage: '/leaderboard clubs',
        description: 'Show club, player, trophy or progression leaderboards.',
      },
    ],
  },
  {
    name: 'Competition',
    entries: [
      {
        name: 'competition',
        usage: '/competition list',
        description:
          'Create, join, submit to and review competitions. Create/end require the competition schema and management permission.',
        permission: 'competitions:manage for create and end',
      },
    ],
  },
  {
    name: 'Membership',
    entries: [
      {
        name: 'members',
        usage: '/members tag:2UG9UGQJY',
        description: 'Show tracked members across registered clubs.',
      },
      {
        name: 'member-verify',
        usage: '/member-verify',
        description:
          'Explain why automatic player-ownership verification is currently unavailable.',
      },
      {
        name: 'member-history',
        usage: '/member-history tag:2UG9UGQJY',
        description: 'Show membership change history for a registered club.',
      },
      {
        name: 'member-search',
        usage: '/member-search player query:PLAYERTAG',
        description:
          'Search by player tag. Discord identity search is restricted to authorised staff.',
        permission: 'members:verify for discord searches',
      },
    ],
  },
  {
    name: 'Staff and moderation',
    entries: [
      {
        name: 'staff',
        usage: '/staff',
        description: 'Show the public staff overview. /staff list is restricted.',
        permission: 'staff:manage for /staff list',
      },
    ],
  },
  {
    name: 'Administration',
    entries: [
      {
        name: 'register-club',
        usage: '/register-club tag:2UG9UGQJY',
        description: 'Preview and register a club after official API validation.',
        permission: 'clubs:write',
      },
      {
        name: 'sync',
        usage: '/sync',
        description: 'Run the existing all-clubs synchronisation pipeline.',
        permission: 'sync:run',
      },
      {
        name: 'sync-status',
        usage: '/sync-status',
        description: 'Show the latest stored synchronisation status.',
        permission: 'sync:run',
      },
      {
        name: 'settings',
        usage: '/settings view',
        description: 'View or change settings for the configured Discord guild.',
        permission: 'clubs:write',
      },
      {
        name: 'audit',
        usage: '/audit',
        description: 'View a read-only, paginated audit log.',
        permission: 'audit:read (server owner)',
      },
    ],
  },
  {
    name: 'Information',
    entries: [
      {
        name: 'help',
        usage: '/help',
        description: 'Show this command directory.',
      },
      {
        name: 'about',
        usage: '/about',
        description: 'Explain BrawlHub’s purpose, data sources and limitations.',
      },
      {
        name: 'status',
        usage: '/status',
        description: 'Show safe public operational health information.',
      },
      {
        name: 'ping',
        usage: '/ping',
        description: 'Check that the Discord bot responds.',
      },
    ],
  },
];

export const ABOUT_SECTIONS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Purpose',
    body:
      'BrawlHub is an independent community project for tracking Brawl Stars clubs, players, memberships and historical changes in one place.',
  },
  {
    title: 'Multi-club tools',
    body:
      'The bot and website can work across multiple registered clubs: browse club and player profiles, compare clubs or players, inspect stored history, follow tracked members and review leaderboards.',
  },
  {
    title: 'Website and Discord bot',
    body:
      'The website provides dashboards and configuration screens. The Discord bot exposes the same BrawlHub data through slash commands and limits administrative actions to authorised global staff.',
  },
  {
    title: 'Official API data',
    body:
      'Club and player information is requested from the official Brawl Stars API on a best-effort basis. Requests are validated; when live data is unavailable, the bot can fall back to previously synchronised snapshots.',
  },
  {
    title: 'Important limitations',
    body:
      'BrawlHub is not affiliated with, endorsed by, or an official product of Supercell. Automatic player-ownership verification is unavailable. Club removal and blacklist commands remain disabled until safe schema support exists. Per-club sync successes and failures are not recorded by the current schema, and data may be stale if synchronisation fails.',
  },
];
