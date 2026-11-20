# Setup

> **Phase 1 note:** the foundation is in place — migration runner, initial RLS schema, web skeleton with a health endpoint, bot skeleton with a `ping` command, and the `shared` / `database` / `logging` packages. The dashboard, Brawl Stars client, sync engine, and Discord auth commands land in later phases.

## Prerequisites

- Node.js **>= 20.11** and npm (`node --version`, `npm --version`)
- A Supabase project
- A Discord application with a bot
- A Brawl Stars developer API key (<https://developer.brawlstars.com/>)

## Environment variables

Copy the template and fill in real values — never commit `.env`:

```sh
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS/Linux
cp .env.example .env
```

Variables (from `.env.example`):

| Group | Variable | Purpose |
| --- | --- | --- |
| App | `NODE_ENV` | `development` locally, `production` in deployment. |
| App | `NEXT_PUBLIC_APP_URL` | Public app URL (the only variable group exposed to the browser). |
| App | `LOG_LEVEL` | Logging level (e.g. `info`). |
| Supabase | `SUPABASE_URL` | Project URL. |
| Supabase | `SUPABASE_ANON_KEY` | Browser key; subject to RLS. |
| Supabase | `SUPABASE_SERVICE_ROLE_KEY` | Server-only key; bypasses RLS, trusted jobs only. |
| Supabase | `DATABASE_URL` | Direct Postgres connection used by `npm run db:migrate`. |
| Brawl Stars | `BRAWL_STARS_API_KEY` | Official developer key, sent as `Authorization: Bearer <key>`; no token endpoint or caching. |
| Brawl Stars | `BRAWL_STARS_BASE_URL` | API base URL (default `https://api.brawlstars.com/v1`). |
| Brawl Stars | `SYNC_INTERVAL_MINUTES` | Sync cadence in minutes (default `15`, clamped to `1`–`1440`). |
| Brawl Stars | `BRAWL_STARS_MIN_INTERVAL_MS` | Minimum delay between Brawl Stars API requests in ms (default `250`). |
| Sync | `SYNC_SECRET` | Server-only bearer secret for `/api/sync`; blank makes the endpoint return `503`. |
| Discord | `OVERVIEW_INTERVAL_MINUTES` | Club stats overview refresh cadence (default `30`, clamped to `1`–`1440`). The channel is set per guild with `/settings set-overview-channel`. |
| Discord | `DISCORD_TOKEN` | Bot token (server-side only). |
| Discord | `DISCORD_CLIENT_ID` | Discord application ID. |
| Discord | `DISCORD_CLIENT_SECRET` | Discord OAuth client secret (server-side only). |
| Discord | `DISCORD_GUILD_ID` | Target Discord server (guild) ID. |
| Discord | `DISCORD_CALLBACK_URL` | OAuth callback, `http://localhost:3000/api/auth/callback` locally. |
| Discord | `DISCORD_NOTIFICATION_CHANNEL_ID` | Optional channel for membership-change notifications; blank disables them. |

Only `NEXT_PUBLIC_*` is exposed to browsers. Keep every other value server-side.

## Discord developer portal steps

1. Open <https://discord.com/developers/applications> and create an application.
2. Copy the **Application ID** into `DISCORD_CLIENT_ID`.
3. Under **OAuth2**, copy the **Client Secret** into `DISCORD_CLIENT_SECRET`.
4. Add the redirect URL to **OAuth2 → Redirects**: `http://localhost:3000/api/auth/callback` (matches `DISCORD_CALLBACK_URL`). Use your production callback URL when deploying.
5. Go to **Bot**, create/reset the bot token, and put it in `DISCORD_TOKEN`.
6. Enable the required privileged Gateway intents (e.g. Server Members) if the bot needs member data.
7. Enable Developer Mode in Discord, right-click your server, and copy its ID into `DISCORD_GUILD_ID`.
8. Invite the bot to that guild with the OAuth2 URL generator (bot scope and the permissions it needs).

## Supabase auth configuration

1. In the Supabase dashboard, open **Authentication → Providers** and enable **Discord**.
2. Paste the Discord **Client ID** and **Client Secret** from step 3/4 above.
3. Add `http://localhost:3000/api/auth/callback` to the allowed redirect URLs (also set your production URL when deploying).
4. Confirm `NEXT_PUBLIC_APP_URL` matches the origin users are browsing.
5. RLS policies are applied by `npm run db:migrate`; verify private tables are not readable anonymously and never expose the service-role key to the client.

## Install and migrate

```sh
npm install
npm run db:migrate
npm run db:status
```

`npm run db:migrate` runs `node scripts/migrate.mjs` against `DATABASE_URL`, applying `supabase/migrations`. `npm run db:status` runs `node scripts/migrate.mjs --status`.

## Running the apps

Everything together:

```sh
npm run dev
```

Web only:

```sh
npm run dev:web
```

Bot only:

```sh
npm run dev:bot
```

Dry-run check of the bot configuration. With no real `DISCORD_TOKEN` in `.env`, the bot logs the missing variable names and exits without connecting; with a valid token it logs in and registers commands:

```sh
npm run bot:start
```

Production build and start:

```sh
npm run build
npm start
```

Quality checks:

```sh
npm run typecheck
npm test
npm run test:watch
```

## Phase 2: register clubs and sync

Apply migrations first (`npm run db:migrate`), then register your real club tags and run a sync:

```sh
npm run clubs:register -- '#TAG1' '#TAG2'
npm run sync:run
```

Replace the `#TAG` placeholders with your actual Brawl Stars club tags. The register script reports `registered` and `rejected` counts and exits non-zero if any tag was rejected; it creates no placeholder clubs. `npm run sync:run` loads the root `.env`, prints the JSON result, and exits non-zero when the status is `failed`.

When a club command is used without `tag:`, the bot automatically uses the guild's only registered club. If the guild has several registered clubs, it shows an actor-bound chooser of that guild's clubs; selecting one continues the original command with its section, sort, filter and period preserved.

### Scheduled sync

The bot runs its first sync about 5 seconds after Discord login and then every `SYNC_INTERVAL_MINUTES` (default `15`, clamped to `1`–`1440`). A local guard skips a tick if the previous in-process run is still in progress, and a Postgres-backed `sync_locks` claim prevents the bot, web cron route and separate CLI processes from overlapping. Timers are cleared on shutdown. Notifications are posted to `DISCORD_NOTIFICATION_CHANNEL_ID` when configured; otherwise the notifier is a no-op so sync can clear its claim. No secrets are logged.

`sync_runs.error` describes the current run status. `sync_runs.last_error` preserves the most recent failure even after that run is retried successfully, so recovery remains auditable. To exercise a full repeated sync while keeping all idempotency protections, run with `SYNC_INTERVAL_MINUTES=1`, wait for the next minute boundary, and run it again.

### Club stats overview

For each guild with an overview channel configured via `/settings set-overview-channel`, the bot posts one compact "Club Stats" message and **edits that same message** every `OVERVIEW_INTERVAL_MINUTES` (default `30`). The first post happens about 15 seconds after Discord login. Each club is one inline field (up to 25, sorted by trophies), and a multi-select "Choose Clubs" menu opens detailed `/club` views for up to 10 selected clubs at once, ephemerally. All values come from stored official Brawl Stars API sync data; global/regional rank and true online status are explicitly caveated because the API does not expose them. Use `/settings clear-overview-channel` to stop posting. Timers are cleared on shutdown.

### Cron route

The web app exposes `POST /api/sync` (and `GET /api/sync`) with the same sync path. Set `SYNC_SECRET` and have your scheduler send it as a bearer token:

```sh
curl -X POST http://localhost:3000/api/sync \
  -H "Authorization: Bearer $SYNC_SECRET"
```

Responses are JSON with `Cache-Control: no-store`: `200` for `completed`/`skipped`, `401` for an invalid or missing token, `503` when `SYNC_SECRET` is unset, and `500` when the sync `failed`. Keep `SYNC_SECRET` server-side; it is never included in responses or logs.

## Health check

The web app exposes `GET /api/health`. With the web server running (`npm run dev:web`), check it with:

```sh
curl http://localhost:3000/api/health
```

The response is JSON containing `status` (`ok` when all checks pass, otherwise `degraded`), `timestamp`, and `checks` with booleans for `supabase` (a live query against `clubs` using the trusted client, when Supabase is configured), `brawlStarsKey`, and `discordConfig`. These are presence checks only — secret values are never read into the response. The endpoint always returns HTTP 200; inspect `status` rather than relying on the HTTP code.

## Deployment notes

- Set all non-`NEXT_PUBLIC_*` variables in the hosting environment (server/function secrets), not in client bundles. Use production values for `NEXT_PUBLIC_APP_URL`, `DISCORD_CALLBACK_URL`, and the Supabase redirect allow list.
- Run `npm run db:migrate` from a trusted deployment step with access to `DATABASE_URL`; keep the service-role key out of public build steps.
- Deploy the web app as a Next.js 16 app and run the bot as a separate long-lived process/worker (`npm run bot:start`). They scale independently.
- In CI, run `npm run typecheck`, `npm test`, and `npm run build` before deploying.
- Ensure RLS is enabled on private tables and that the service-role key is used only by trusted jobs.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Node version` / engine warnings | Node older than 20.11 | Install Node >= 20.11 and re-run `npm install`. |
| Migration fails to connect | Wrong `DATABASE_URL` | Check the direct Postgres connection string and network access; re-run `npm run db:migrate`. |
| Supabase reads return empty or 401 | Wrong anon key, or RLS blocking rows | Verify `SUPABASE_URL`/`SUPABASE_ANON_KEY` and the user's club mapping/RLS policies. Do not "fix" by using the service-role key in the browser. |
| Discord login rejected / redirect mismatch | Callback URL not allowed | Add the exact `DISCORD_CALLBACK_URL` to Discord OAuth2 Redirects and Supabase allowed redirect URLs. |
| Bot fails to connect or times out | Bad `DISCORD_TOKEN` or missing intents | Reset the token in the developer portal, update `DISCORD_TOKEN`, and enable required privileged intents. |
| Brawl Stars API 401/403 | Invalid/missing key or wrong header | Confirm `BRAWL_STARS_API_KEY` is sent as `Authorization: Bearer <key>` from server code only. |
| Port 3000 already in use | Another local process | Stop that process or change the web port and update `NEXT_PUBLIC_APP_URL`/`DISCORD_CALLBACK_URL` to match. |
| Health check reports `degraded` | Supabase query failed, or `BRAWL_STARS_API_KEY` / `DISCORD_TOKEN` not configured | Check those env values and database connectivity; the endpoint reports presence only, never secrets. |
| Health check returns 404 | Web server not running on port 3000, or wrong path | Start `npm run dev:web` and request `/api/health`. |
