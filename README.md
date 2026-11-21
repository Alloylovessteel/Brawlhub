# BrawlHub

BrawlHub is a private website and Discord bot for managing **11–20 Brawl Stars clubs from one Discord server**. It reads club and roster data from the official Brawl Stars API, stores it in Supabase, and presents real rosters, membership history, trophy progression and sync health in a Next.js dashboard.

Current status: **all planned bot and website foundations are in place**, including official-API sync, guild-scoped history and ranked roles, polished bot embeds/assets, public `/me image` player cards, and a consolidated 18-command slash interface. The website and bot work with real clubs you register and synchronise from the official Brawl Stars API. Player profiles, trophy history, membership history, collected battle history and ranked roles are guild-scoped; no placeholder clubs, players or historical records are generated.

## Architecture

This is an npm workspaces monorepo:

| Path | Role |
| --- | --- |
| `apps/web` | Next.js 16 App Router website, Discord OAuth2, RBAC, dashboards and admin APIs. |
| `apps/bot` | discord.js bot, periodic sync scheduler and optional membership notifications. |
| `packages/shared` | Roles, permission matrix and validated Brawl Stars/Discord input schemas. |
| `packages/database` | Supabase anon/client helpers and service-role client for trusted jobs. |
| `packages/brawl-stars` | Official Brawl Stars API client with Bearer key, retry/backoff and throttling. |
| `packages/brawlapi` | Optional cached BrawlAPI static metadata client for icons, badges, maps and mode assets. |
| `packages/sync` | Club registration, sync lock, snapshots, membership transitions and notification claims. |
| `packages/logging` | Structured JSON-lines logger with secret redaction. |
| `supabase/migrations` | Schema, constraints, indexes and RLS policies. |
| `scripts` | Migration runner, sync/register CLIs, inspection and security verification scripts. |

Browser reads use the Supabase anonymous key and RLS. Service-role access is restricted to trusted server code: auth provisioning, admin mutations, sync and migrations. No Discord bot token, Discord client secret, Supabase service-role key, Supercell API key or database URL is exposed to the browser.

See [docs/architecture.md](docs/architecture.md), [docs/setup.md](docs/setup.md) and [docs/phase3-foundations.md](docs/phase3-foundations.md) for design details. For the Discord command consolidation, see the [slash-command migration map](docs/command-migration.md).

## Prerequisites

- Node.js **>= 20.11** and npm
- A Supabase project with:
  - Project URL
  - Anon key
  - Service-role key
  - Direct Postgres connection string
- A Discord application/bot with:
  - Bot token
  - Application/client ID
  - Client secret
  - Guild/server ID
  - OAuth redirect URL configured
- A Brawl Stars developer API key from <https://developer.brawlstars.com/>

## First-time local setup

Follow these steps in order from the repository root.

### 1. Create the environment file

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```sh
cp .env.example .env
```

Open `.env` and fill in the real values. It is gitignored; never commit it.

### 2. Install dependencies

```sh
npm install
```

### 3. Configure Supabase Auth for Discord

In your Supabase project:

1. Go to **Authentication → Providers → Discord**.
2. Enable the provider.
3. Enter `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
4. Add this redirect URL:

   ```text
   http://localhost:3000/api/auth/callback
   ```

5. Make sure `NEXT_PUBLIC_APP_URL=http://localhost:3000` locally.

The application requests Discord scopes `identify email guilds`. Supabase validates the OAuth `state`; the callback additionally verifies that the user is a member of `DISCORD_GUILD_ID`.

### 4. Apply database migrations

```sh
npm run db:migrate
npm run db:status
```

`db:status` should report all migrations applied, including `0005_phase3_rls.sql`, `0006_supabase_preview_policy_fix.sql`, and `0007_phase3_rls_hardening.sql`, with zero pending.

### 5. Register clubs and collect real data

Register each club you want BrawlHub to track (after verifying the tag/name in the official Brawl Stars API):

```sh
npm run clubs:register -- '#CLUBTAG1' '#CLUBTAG2'
```

You can also register clubs by hand in Discord with `/clubs register tag:<club-tag>` (requires `clubs:write` permission); it previews official API data and asks for confirmation before registering anything.

Run a sync:

```sh
npm run sync:run
```

Inspect the result:

```sh
npm run phase2:inspect
```

### 6. Configure Discord role mapping

The guild owner always receives global `owner`. Additional grants require explicit configuration in `.env`:

```dotenv
DISCORD_OWNER_ROLE_IDS=123456789012345678
DISCORD_ADMIN_ROLE_IDS=123456789012345679
DISCORD_ROLE_MAP={"CLUBTAG":{"presidentRoleIds":["123456789012345680"],"staffRoleIds":["123456789012345681"]}}
```

Rules:

- Discord role IDs are validated as snowflakes.
- Unconfigured Discord roles never grant BrawlHub permissions.
- Verified guild members with no elevated role receive `member` for each registered club.
- Manual grants made in the admin interface persist across future Discord logins.

### 7. Start the website

Website only:

```sh
npm run dev:web
```

Website and Discord bot together:

```sh
npm run dev
```

Open:

```text
http://localhost:3000/login
```

Click **Continue with Discord**. After a successful login you should land on `/dashboard`.

### 8. Stop the app

Press `Ctrl+C` in the terminal running the dev server or `npm run dev`.

## Website walkthrough

| Route | What to verify |
| --- | --- |
| `/login` | Discord sign-in, logout message and localized error messages. |
| `/dashboard` | Real club count, unique players, open memberships, latest successful sync, recent events, club comparison and stale/failure warnings. |
| `/dashboard/clubs` | All registered clubs with tags, member counts, trophies, required trophies and last updated snapshot time. Search is server-side. |
| `/dashboard/clubs/[clubId]` | Real roster ranked by trophies, club events, snapshot history and snapshot-only trophy chart. Management forms appear only for authorised users. |
| `/dashboard/players` | Searchable and club-filterable player directory with current club, role, trophies and unavailable-value handling. |
| `/dashboard/players/[playerId]` | Real player record, memberships, join/leave/transfer timeline and snapshot-only trophy chart. |
| `/dashboard/leaderboards` | Club and player rankings calculated from stored records; per-club filter and real club progression. |
| `/dashboard/history` | Time-range filters and snapshot-only charts for club trophies, member counts and a selected player's trophies. |
| `/dashboard/admin` | Owner/admin sync trigger, manual role assignment, guild settings, audit log and recent sync runs. Audit log is owner-only. |

If a club has only one snapshot, the chart shows that real point and the history page states when collection began. No values are interpolated.

## Permission model

| Requested role | Stored representation | Access |
| --- | --- | --- |
| Server Owner | global `owner` | Full access, all clubs, global roles, system settings and audit log. |
| Server Administrator | global `admin` | All clubs, club staff and administrative tools. No audit log. |
| Club President | club `owner` | Their club's roster, settings and authorised club staff. |
| Club Staff | club `staff` | Their club's permitted information and authorised management functions. |
| Member | club `member` | Club/player information and server-wide leaderboards/statistics. |
| Guest | no verified guild membership or grant | No dashboard access. |

Permissions are enforced in two layers:

1. Server-side guards in Next.js route handlers and Server Components.
2. Supabase RLS policies using `is_global_staff()`, `has_club_access()` and `is_global_owner()`.

Client-provided user IDs, club IDs and permission claims are never trusted. All mutation inputs are validated with Zod, and sensitive POST routes check the request origin and apply in-process rate limits.

## Testing and verification

Run the complete automated suite from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run verify:secrets
npm run verify:rls
npm run db:status
npm run phase2:inspect
```

`npm run verify:secrets` must be run after `npm run build`; it scans built browser assets for private credential values. `npm run verify:rls` checks RLS policy metadata and service-only grants without modifying rows.

### Manual authentication checklist

These require a real Discord account in the configured guild:

- [ ] Successful login redirects to `/dashboard`.
- [ ] Cancelling the Discord consent screen redirects to `/login?error=oauth_denied`.
- [ ] Tampering with the OAuth `state` fails before the app callback completes.
- [ ] A user outside `DISCORD_GUILD_ID` is denied and signed out.
- [ ] Logout returns to `/login?loggedOut=1` and protected routes redirect to login.
- [ ] An expired or invalidated session cannot open `/dashboard`.
- [ ] A guest cannot open any `/dashboard/*` route.

### Manual permission checklist

- [ ] Server Owner sees Admin, can run sync, assign global roles and read the audit log.
- [ ] Server Administrator sees Admin, can run sync and manage club staff, but not the audit log.
- [ ] Club President sees management controls only for their assigned club.
- [ ] Club Staff cannot open club settings or staff forms.
- [ ] Member cannot open `/dashboard/admin` or another club's restricted management functions.
- [ ] Changing a club ID in the URL or form does not grant access.

### Data regression checklist

- [ ] `phase2:inspect` still reports 3 clubs, 80 players, 80 open memberships and preserved membership events.
- [ ] Club dashboard rosters match the registered club member counts.
- [ ] Player profiles use stored membership events and snapshots only.
- [ ] Leaderboards match current stored trophy values.
- [ ] Historical charts contain only stored snapshot points.
- [ ] Website browsing does not create notifications or modify snapshots.

### Bot and sync regression

```sh
npm run bot:start
npm run sync:run
npm run phase2:inspect
```

The bot reports missing configuration and exits safely when `DISCORD_TOKEN` is blank. Sync concurrency is still protected by the existing Postgres-backed `sync_locks` table and idempotency checks.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run web and bot together. |
| `npm run dev:web` | Run the Next.js dev server on port 3000. |
| `npm run dev:bot` | Run the Discord bot through `tsx`. |
| `npm run build` | Production build of `@brawlhub/web`. |
| `npm start` | Start the built website on port 3000. |
| `npm run bot:start` | Start the Discord bot. |
| `npm run typecheck` | Typecheck all TypeScript workspaces. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run db:migrate` | Apply pending migrations. |
| `npm run db:status` | Show applied and pending migrations. |
| `npm run clubs:register -- '#TAG'` | Register a real club tag. |
| `npm run sync:run` | Run one sync from the root `.env`. |
| `npm run phase2:inspect` | Print real database counts and sync history. |
| `npm run verify:secrets` | Check built browser assets for private credential values. |
| `npm run verify:rls` | Check scoped history RLS policy metadata. |
| `npm run verify:security` | Run both security verification scripts. |

## Cron / scheduled sync

`GET` or `POST` `/api/sync` still runs the same official-API sync engine with the shared secret:

```sh
curl -X POST http://localhost:3000/api/sync \
  -H "Authorization: Bearer $SYNC_SECRET"
```

Owners and administrators can also run the same engine from `/dashboard/admin`; that route uses the session and RBAC guards instead of a bearer token.

## Production deployment

1. Set all required environment variables in the hosting platform. Keep `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `BRAWL_STARS_API_KEY`, `SYNC_SECRET`, `DISCORD_TOKEN` and `DISCORD_CLIENT_SECRET` server-only.
2. Add the production OAuth callback URL, for example `https://example.com/api/auth/callback`, to Supabase Auth and Discord.
3. Set `NEXT_PUBLIC_APP_URL` to the production origin and `NODE_ENV=production` so Supabase session cookies use `Secure`.
4. Run `npm ci`, then `npm run db:migrate`, then `npm run build`.
5. Start with `npm start`. Run the bot separately with `npm run bot:start` if automated scheduling/notifications are required.
6. Run `npm run verify:secrets` and `npm run verify:rls` after deployment where the environment permits.

The in-process rate limiter is per Node instance. Multi-instance deployments should replace it with a shared store such as Redis.

## Data notes

- `clubs.last_synced_at` is not populated by the current sync; the UI prefers the latest real snapshot timestamp.
- Player statistics such as `power_points`, `victories`, `solo_victories` and `team_victories` are often null in the official API data. They are displayed as **Unavailable**, never as zero.
- `player_snapshots.raw` contains the collected club-member payload, not a full player API response.
- Discord notifications remain disabled unless `DISCORD_NOTIFICATION_CHANNEL_ID` is set. Viewing the website never sends announcements.

## Known limitations

- Interactive Discord OAuth requires a real configured Discord application, Supabase provider and guild member; it cannot be fully verified by unit tests alone.
- Manual permission and role tests against real Discord accounts must be performed in the deployed environment.
- Historical charts are limited by actual collection frequency; currently only a small number of snapshots exist.
- Rate limiting is process-local rather than distributed.
