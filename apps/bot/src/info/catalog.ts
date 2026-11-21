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
        name: 'clubs',
        usage:
          '/clubs details | /clubs overview | /clubs members | /clubs leaderboard | /clubs log | /clubs history | /clubs compare | /clubs view add|remove|list | /clubs fields | /clubs logs add|remove|list | /clubs register | /clubs remove',
        description:
          'Show club details and overviews, list members, logs and history, compare clubs, and configure the server’s club overview and reports.',
        permission: 'clubs:write for overview, view, fields, logs, register and remove',
      },
    ],
  },
  {
    name: 'Player',
    entries: [
      {
        name: 'me',
        usage: '/me [tag:PLAYERTAG]',
        description:
          'Show an interactive player overview with Summary, Brawlers and More sections. Leave tag blank to use your verified player.',
      },
      {
        name: 'brawlers',
        usage:
          '/brawlers list [tag:PLAYERTAG] [sort:trophies] [filter:all] | /brawlers detail name:BRAWLER [tag:PLAYERTAG]',
        description:
          'Show a player’s full brawler roster from official data, with sorting, filtering and full details for one brawler.',
      },
      {
        name: 'player',
        usage:
          '/player history tag:PLAYERTAG | /player battles tag:PLAYERTAG | /player clubs tag:PLAYERTAG | /player compare first:PLAYERTAG second:OTHERTAG',
        description: 'Show stored player history, battles, clubs and head-to-head comparisons.',
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
        usage:
          '/members roster | /members account list | /members account verify start tag:<tag> | /members verify list | /members search player query:PLAYERTAG',
        description:
          'Show tracked members and manage linked accounts, verification, identity data and verified-member searches.',
        permission: 'members:verify for management actions and discord searches',
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
        name: 'sync',
        usage: '/sync run | /sync status',
        description: 'Run the all-clubs synchronisation pipeline or show the latest stored status.',
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
        name: 'inactivity',
        usage: '/inactivity view | /inactivity set days:4 channel:#club-reports | /inactivity disable',
        description:
          'Configure the scheduled club inactivity digest with a customizable number of days.',
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
      {
        name: 'club-roles',
        usage: '/club-roles setup | /club-roles set rank:President role:@Role | /club-roles refresh',
        description:
          'Assign President, Vice President and Senior Discord roles from verified main accounts and stored official club ranks.',
        permission: 'clubs:write to configure or refresh',
      },
    ],
  },
  {
    name: 'Information',
    entries: [
      {
        name: 'help',
        usage: '/help directory | /help about | /help status | /help ping',
        description: 'Show this command directory, project information, status or bot connectivity.',
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
      'BrawlHub is not affiliated with, endorsed by, or an official product of Supercell. Player ownership is verified only through an explicit in-game icon challenge confirmed via the official Brawl Stars API (players must set the exact required default brawler icon shown by the bot; other icons do not verify, and ownership is never inferred from names, tags, or Discord profiles). Blacklist commands remain disabled until safe schema support exists. Per-club sync successes and failures are not recorded by the current schema, and data may be stale if synchronisation fails.',
  },
];
