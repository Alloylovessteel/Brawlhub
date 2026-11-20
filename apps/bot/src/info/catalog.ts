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
        usage: '/club tag:<club-tag> section:Member Details sort:Current trophies',
        description:
          'Show club info, staff, sorted/filtered member details and previous members from stored official data.',
      },
      {
        name: 'clubs',
        usage: '/clubs',
        description: 'BrawlTools-style overview of registered clubs from stored official data.',
      },
      {
        name: 'club-members',
        usage: '/club-members tag:<club-tag>',
        description: 'List tracked members of a registered club.',
      },
      {
        name: 'club-leaderboard',
        usage: '/club-leaderboard',
        description: 'Rank registered clubs by trophies.',
      },
      {
        name: 'club-log',
        usage: '/club-log tag:<club-tag> period:Daily (Today)',
        description:
          'Show daily or weekly per-member trophy changes for a registered club from stored sync snapshots.',
      },
      {
        name: 'club-history',
        usage: '/club-history tag:<club-tag>',
        description: 'Show stored history for a registered club.',
      },
      {
        name: 'club-compare',
        usage: '/club-compare first:<club-tag> second:<club-tag>',
        description: 'Compare two registered clubs using stored data.',
      },
      {
        name: 'view',
        usage: '/view tag add|remove|list',
        description: 'Choose which registered clubs appear in this server’s auto-updated overview.',
        permission: 'clubs:write',
      },
      {
        name: 'club-overview',
        usage: '/club-overview menu',
        description:
          'Toggle which stored details appear in this server’s auto-posted club overview.',
        permission: 'clubs:write',
      },
      {
        name: 'clublogs',
        usage: '/clublogs add|remove|list',
        description:
          'Post stored membership, role and capacity changes for a registered club to a channel.',
        permission: 'clubs:write',
      },
    ],
  },
  {
    name: 'Player',
    entries: [
      {
        name: 'me',
        usage: '/me [tag:PLAYERTAG]',
        description: 'Show a player profile and club context. Leave tag blank to use your verified player.',
      },
      {
        name: 'player-history',
        usage: '/player-history tag:PLAYERTAG',
        description: 'Show stored trophy and club history for a player.',
      },
      {
        name: 'player-battles',
        usage: '/player-battles tag:PLAYERTAG',
        description: 'Show stored battle-log history and results for a player.',
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
    name: 'Game data',
    entries: [
      {
        name: 'events',
        usage: '/events active|upcoming',
        description:
          'Show the live official Brawl Stars event rotation with map and game-mode images.',
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
        usage: '/members tag:<club-tag>',
        description: 'Show tracked members across registered clubs.',
      },
      {
        name: 'member-verify',
        usage: '/member-verify start tag:<tag>',
        description:
          'Verify player ownership by setting your in-game icon to a random required default brawler icon shown by the bot, then run /member-verify check to confirm via the official API.',
      },
      {
        name: 'accounts',
        usage: '/accounts list | /accounts set-main tag:<tag>',
        description: 'List your linked accounts as main/alt and choose your main account.',
      },
      {
        name: 'delete-me',
        usage: '/delete-me',
        description: 'Permanently delete your BrawlHub identity data after confirmation.',
      },
      {
        name: 'verify-info',
        usage: '/verify-info',
        description: 'Post the player verification guide in the current channel.',
        permission: 'members:verify',
      },
      {
        name: 'verify-settings',
        usage: '/verify-settings',
        description: 'Show this server’s verification settings.',
        permission: 'members:verify',
      },
      {
        name: 'member-history',
        usage: '/member-history tag:<club-tag>',
        description: 'Show membership change history for a registered club.',
      },
      {
        name: 'member-search',
        usage: '/member-search player query:PLAYERTAG',
        description:
          'Search by player tag. Discord identity search is restricted to authorised staff.',
        permission: 'members:verify for discord searches',
      },
      {
        name: 'fn',
        usage: '/fn list | /fn set tier:DIAMOND role:@ROLE | /fn me',
        description:
          'View ranked roles, map an official tier to a Discord role, or refresh your own role.',
        permission: 'clubs:write for /fn set',
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
        usage: '/register-club tag:<club-tag>',
        description: 'Preview and register a club after official API validation.',
        permission: 'clubs:write',
      },
      {
        name: 'remove-club',
        usage: '/remove-club club:<club-tag>',
        description:
          'Archive a registered club without deleting snapshots, memberships, roles or history.',
        permission: 'clubs:write',
      },
      {
        name: 'tag',
        usage: '/tag set user:@USER tag:<tag>',
        description: 'Staff-link a Discord user to a verified Brawl Stars player.',
        permission: 'members:verify',
      },
      {
        name: 'register-list',
        usage: '/register-list',
        description: 'List verified account links for this server’s tracked players.',
        permission: 'members:verify',
      },
      {
        name: 'find',
        usage: '/find user @USER | /find tag <tag>',
        description: 'Find a verified account link in this server.',
        permission: 'members:verify',
      },
      {
        name: 'unverify-one',
        usage: '/unverify-one tag <tag>',
        description: 'Revoke one verified account link after confirmation.',
        permission: 'members:verify',
      },
      {
        name: 'unverify-all',
        usage: '/unverify-all user:@USER',
        description: 'Revoke every verified account link for a user after confirmation.',
        permission: 'members:verify',
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
        usage: '/settings view | /settings set-report-channel',
        description:
          'View or change guild settings, including per-report daily/weekly/monthly channels.',
        permission: 'clubs:write',
      },
      {
        name: 'audit',
        usage: '/audit',
        description: 'View a read-only, paginated audit log.',
        permission: 'audit:read (server owner)',
      },
      {
        name: 'auto',
        usage: '/auto setup',
        description:
          'Create or reuse ranked roles and post the verification guide without creating channels.',
        permission: 'clubs:write',
      },
      {
        name: 'update',
        usage: '/update',
        description:
          'Refresh ranked roles for verified main accounts in this server from stored official data.',
        permission: 'clubs:write',
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
      'BrawlHub is not affiliated with, endorsed by, or an official product of Supercell. Player ownership is verified only through an explicit in-game icon challenge confirmed via the official Brawl Stars API (players must set the exact required default brawler icon shown by the bot; other icons do not verify, and ownership is never inferred from names, tags, or Discord profiles). Club removal and blacklist commands remain disabled until safe schema support exists. Per-club sync successes and failures are not recorded by the current schema, and data may be stale if synchronisation fails.',
  },
];
