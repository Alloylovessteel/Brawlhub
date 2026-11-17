# BrawlHub

BrawlHub is a website + Discord bot for running **11–20 clubs in one Discord server**. It reads club and roster data from the **official Brawl Stars API** and stores it in **Supabase**, so club leadership has a single place to review rosters, membership changes, and club-level summaries.

> **Phase 1 is foundation only.** The dashboard, data sync, and Discord auth commands arrive in later phases. See [Phase 1 status](#phase-1-status).

## Architecture summary

The repository is an npm workspaces monorepo:

| Path | Role |
| --- | --- |
| `apps/web` | Next.js 16 web app (foundation: health endpoint; dashboard/auth routes later). |
| `apps/bot` | discord.js 14 bot (foundation: `ping` command; more commands later). |
| `packages/shared` | Shared types, constants, and pure helpers. |
| `packages/database` | Postgres/Supabase access and query helpers. |
| `packages/brawl-stars` | Planned: official Brawl Stars API client (Bearer key, no token cache). |
| `packages/logging` | Shared structured logger. |
| `supabase/migrations` | SQL migrations (RLS policies, tables, constraints). |
| `scripts/migrate.mjs` | Migration runner used by `npm run db:migrate`. |

Access is split by trust: browsers talk to Supabase with the anon key under row-level security (RLS), while trusted server-side jobs use the service-role key. Supabase Auth owns user sessions; this app stores no Discord tokens. See [docs/architecture.md](docs/architecture.md) for the full design.

## Prerequisites

- **Node.js >= 20.11** (see `engines` in `package.json`) and npm
- A **Supabase project** (URL, anon key, service-role key, and a direct Postgres connection string)
- A **Discord application/bot** (bot token, application ID, client secret, guild ID)
- A **Brawl Stars developer API key** from <https://developer.brawlstars.com/>

## Setup

1. Copy `.env.example` to `.env` and fill in real values:
   - Windows (PowerShell): `Copy-Item .env.example .env`
   - macOS/Linux: `cp .env.example .env`
2. Install dependencies: `npm install`
3. Apply database migrations: `npm run db:migrate`
4. In Supabase, enable the **Discord** auth provider and add `http://localhost:3000/api/auth/callback` to the allowed redirect URLs.
5. Start the web app and bot together: `npm run dev`
6. Verify the bot with a configuration dry-run: `npm run bot:start` (with no real `DISCORD_TOKEN`, it reports missing values and exits without connecting)
7. Build for production: `npm run build`
8. Run tests: `npm test`
9. Typecheck: `npm run typecheck`

Full step-by-step instructions are in [docs/setup.md](docs/setup.md).

## Scripts

Commands defined at the repository root (`package.json`):

| Command | Description |
| --- | --- |
| `npm run dev` | Run web and bot together (`concurrently`, labels `web` / `bot`). |
| `npm run dev:web` | Run the `apps/web` Next.js dev server. |
| `npm run dev:bot` | Run the `apps/bot` bot in dev mode. |
| `npm run build` | Production build of `@brawlhub/web`. |
| `npm start` | Start the built web app. |
| `npm run bot:start` | Start the bot (configuration/connection dry-run). |
| `npm run typecheck` | `tsc --noEmit` with the root `tsconfig.json`. |
| `npm test` | Run the Vitest suite once (`vitest run`). |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run db:migrate` | Apply migrations via `scripts/migrate.mjs`. |
| `npm run db:status` | Show migration status (`scripts/migrate.mjs --status`). |

## Security notes

- **Secrets stay server-side.** Only `NEXT_PUBLIC_*` variables are exposed to the browser. Never put the service-role key, bot token, or Brawl Stars API key in a `NEXT_PUBLIC_*` variable or client bundle.
- **User-scoped access.** Private tables are protected by Supabase RLS keyed on `auth.uid()`; users can only read data for clubs they are allowed to see.
- **Least privilege.** The service-role key (which bypasses RLS) is used only by trusted jobs such as migrations and sync. It is never used from browser code.
- **No stored Discord tokens.** Supabase Auth owns sessions and the Discord provider link; this application persists no Discord OAuth/refresh tokens. `DISCORD_TOKEN` is the bot's own credential, kept server-side.
- **No fabricated stats.** Every displayed number is derived from official API data. When data is missing or a sync has not run, show it as unavailable rather than inventing values.

## Phase 1 status

This is the foundation phase. The root configuration, `.env` template, migration runner, initial RLS schema, workspace skeletons (web health endpoint and bot `ping` command), and the `shared` / `database` / `logging` packages are in place. The dashboard, sync engine, Brawl Stars API client, and Discord auth commands arrive in later phases. Do not read the scaffolding as shipped product features.
