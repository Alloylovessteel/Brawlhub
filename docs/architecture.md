# Architecture

This document describes the data and security design for BrawlHub. Phase 1 establishes the foundation: root configuration, the `.env` template, the migration runner, the initial schema with RLS, workspace skeletons (web health endpoint, bot ping command), and the `shared`, `database`, and `logging` packages. The dashboard, sync engine, and Discord auth commands come in later phases. See the [phase roadmap](#phase-roadmap).

## Goals

- Support **11–20 clubs in one Discord server** from a single deployment.
- Use only the **official Brawl Stars API** as a data source.
- Keep every user's access **scoped to their own clubs**.
- Make synchronization **idempotent and restart-safe** (no duplicate rows or events).
- Store **no Discord OAuth tokens** in our database.

## Trust boundaries

There are three distinct callers of the database:

| Caller | Credential | Access model |
| --- | --- | --- |
| Browser / web app | `SUPABASE_ANON_KEY` | Row-level security (RLS), scoped to `auth.uid()`. |
| Trusted jobs (migration runner, future sync worker, bot) | `SUPABASE_SERVICE_ROLE_KEY` / `DATABASE_URL` | Bypass RLS; used only in server-side code. |
| Supabase Auth | managed internally | Owns user sessions and the Discord provider link. |

Only `NEXT_PUBLIC_*` variables may reach the browser. The service-role key, direct `DATABASE_URL`, `DISCORD_*` secrets, and `BRAWL_STARS_API_KEY` must remain server-side. The web app's request-scoped Supabase client uses the anon key only.

## User-scoped Supabase access: RLS vs service role

- **RLS is enabled on every table.** Public tables have an explicit `SELECT ... USING (true)` policy; private tables have policies keyed on `auth.uid()` resolved through club-scoped roles.
- **Authorization uses `user_roles`.** Rows carry `scope` (`global` or `club`), `club_id`, and `role` (`owner`, `admin`, `staff`, `member`). Because `user_roles` is intentionally invisible to clients, policies call `SECURITY DEFINER` helpers — `is_global_staff(auth.uid())`, `has_club_access(auth.uid(), club_id)`, and `has_competition_access(...)` — which read roles on the caller's behalf.
- **Read-only for clients.** There are no `INSERT`/`UPDATE`/`DELETE` policies for `anon` or `authenticated` anywhere. All writes are performed by the trusted service role, which bypasses RLS.
- **Service-role access is narrowly held.** The service-role key is used only by trusted jobs: applying migrations, running sync, and maintaining derived data. It is loaded from server-only environment variables and never bundled into the web client.
- **No `SESSION_SECRET`.** Sessions are issued and managed by Supabase Auth; there is no app-managed session encryption or token store.

## Public vs private tables

| Classification | Tables | Access |
| --- | --- | --- |
| Public | `clubs`, `players` | Anonymous and authenticated `SELECT` via RLS policy. |
| Private, user-scoped | `profiles` (own row / global staff), `club_private`, `club_memberships`, `guild_settings`, `staff_members`, `competitions`, `competition_entries`, `blacklists`, `audit_logs` | Authenticated `SELECT` subject to RLS policies using the helpers above. |
| Service-role only | `sync_runs`, `membership_events`, `club_snapshots`, `player_snapshots`, `notifications`, `user_roles`, `discord_users` | No client policies or grants at all in Phase 1; trusted jobs only. |

Nothing is public by accident: a table becomes readable only through a deliberate policy and grant. Later phases may add narrowly scoped `SELECT` policies for some service-role-only tables (for example club-scoped membership events), but never for tokens or unrestricted history.

## Temporal `club_memberships` (transfers)

Membership is modeled as a validity interval, not a mutable current-club column, so history is preserved and transfers are representable:

- Columns: `club_id`, `player_id`, `role`, `valid_from`, `valid_to` (nullable — `NULL` means "still current").
- A **transfer** closes the old row (`valid_to = t`) and opens a new row for the destination club (`valid_from = t`). Both rows remain for history.
- A unique index on `(player_id)` where `valid_to IS NULL` guarantees at most one open membership per player; transfer logic must close the old row first.
- "Who was in club X at time T" is a range predicate: `valid_from <= T AND (valid_to IS NULL OR valid_to > T)`.

## `membership_events`

An append-only, service-role-only event log that records how rosters changed:

- Columns: `player_id`, `from_club_id` (nullable), `to_club_id` (nullable), `event_type`, `source_sync_run_id`, `detected_at`.
- Event types: `join` (`to_club_id` set), `leave` (`from_club_id` set), and `transfer` (both set).
- Events are derived by diffing the current API snapshot against the previous membership state.
- **Idempotency:** `UNIQUE NULLS NOT DISTINCT (player_id, event_type, from_club_id, to_club_id, source_sync_run_id)` makes replaying a sync a no-op via `ON CONFLICT DO NOTHING`.

## `sync_runs`

One row per sync scope and period, used for auditing and concurrency control:

- Columns: `scope`, `period_start`, `status` (`running` / `completed` / `failed`), `started_at`, `finished_at`, `error`, `records_processed`.
- **Unique constraint on `(scope, period_start)`** prevents duplicate run records for the same period.
- **Advisory lock (sync runner design):** each sync acquires a Postgres transaction-scoped advisory lock keyed by `(scope, period_start)` before doing work, then re-checks the unique run row inside the lock. This serializes concurrent workers and makes restarts safe. The lock is applied by the sync runner, not by the Phase 1 schema.
- Reported counts come from rows actually written during the run; no numbers are invented.

## Idempotency constraints across snapshots, events, and notifications

All sync-derived writes are upserts with conflict handling so repeated runs converge:

- **Snapshots:** `club_snapshots` is unique on `(club_id, sync_run_id)` and `player_snapshots` on `(player_id, sync_run_id)` — one raw snapshot per entity per run. The raw API response is retained in `raw` with a `payload_hash` for auditability.
- **Events:** the `NULLS NOT DISTINCT` unique key described above prevents duplicate membership events.
- **Notifications:** unique on `(event_id, channel_id, kind)` — one message per logical event per Discord channel/kind.
- Summaries and events are derived from snapshots, never fabricated.

## Brawl Stars API client

- Base URL comes from `BRAWL_STARS_BASE_URL`.
- Every request sends `Authorization: Bearer ${BRAWL_STARS_API_KEY}`.
- There is **no token endpoint and no token cache**: the developer API key is a static credential sent directly on each request.
- The client is server-side only (`packages/brawl-stars`); it never runs in the browser. It handles throttling, retry/backoff and response validation, and is the single entry point for official API data.
- Official static endpoints are preferred: `GET /brawlers` supplies authoritative brawler IDs/names and `GET /events/rotation` supplies the live map/mode rotation.

## Static metadata (BrawlAPI)

- `packages/brawlapi` is a cached, server-side-only client for `https://api.brawlapi.com`.
- BrawlAPI is used only for metadata the official API does not expose: profile icon, club badge, brawler portrait, map and game-mode asset URLs.
- Names, trophies, rosters, rankings, battle history and live events always come from the official Brawl Stars API or stored official API snapshots. BrawlAPI failures degrade to Unicode/URL fallbacks and never fail a Discord command.
- BrawlAPI `/v1/events` is not used: it is a static catalogue and cannot replace the official live `GET /events/rotation` endpoint.

## No stored OAuth tokens

- Discord sign-in is handled by **Supabase Auth**. Supabase owns the session and the provider linkage; the application schema contains no Discord access/refresh token columns. `discord_users` is a directory cache only.
- `DISCORD_TOKEN` is the bot account's own credential (not an OAuth token) and is read server-side only.
- Removing `SESSION_SECRET` reflects this: there is no separate app-managed session or token-encryption layer.

## Data flow

1. A user signs in with Discord through Supabase Auth and receives a Supabase session.
2. The web app reads user-scoped data with the anon key; RLS limits rows to the user's roles/clubs. The health endpoint reports presence checks only.
3. A trusted sync job (later phase) takes the advisory lock, records a `sync_run`, calls the Brawl Stars API with the Bearer key, writes snapshots, derives temporal memberships and `membership_events`, and emits idempotent notifications.
4. The bot uses server-side credentials for its commands; no Discord OAuth tokens are persisted by the app.

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Verified main/alt accounts, Discord identity links, admin authorization and guild-scoped configuration | Implemented |
| 2 / 2B | Official API sync, registered guild clubs, club commands, overview toggles, club logs and scheduled reports | Implemented |
| 3 | Player profiles, trophy/membership history, official battle-log history in bot and web, scoped history RLS | Implemented |
| 4 | Ranked-role commands (`/fn`), `/auto setup`, and full `/update` refresh | Next |
| 5 | Image and asset presentation work | Deferred |

Every phase keeps reads and writes inside the invoking Discord guild. Player and club statistics, rosters and battle logs come only from the official Brawl Stars API or stored official snapshots; BrawlAPI supplies static metadata and assets only.
