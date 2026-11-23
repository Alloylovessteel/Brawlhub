# BrawlHub Supabase / Postgres

This folder contains the local Supabase configuration and the SQL migrations that
define the BrawlHub database.

## Layout

- `config.toml` — minimal Supabase local dev config (API `54321`, DB `54322`, Studio `54323`).
  The Discord provider is enabled with values resolved from `DISCORD_CLIENT_ID` and
  `DISCORD_CLIENT_SECRET` environment variables; no secrets are committed.
- `migrations/0001_initial_schema.sql` — initial schema, indexes, triggers, RLS policies and grants.

## Applying migrations

Migrations are applied with the repository script (it uses `pg` from the root
devDependencies). Set `DATABASE_URL` in the root `.env` (see `.env.example`) or
in your shell:

```sh
npm run db:status   # list applied / pending migrations, no changes
npm run db:migrate  # apply all pending migrations
```

The script:

- reads `DATABASE_URL` from the environment, falling back to a simple parser for the root `.env`;
- tracks applied versions by filename in `public.schema_migrations` (`version`, `checksum`, `applied_at`);
- hashes each migration with SHA-256 and skips matching applied versions;
- exits with an error if an already-applied file's checksum changed (do not edit applied migrations — add a new one);
- runs every migration in a single transaction and never logs connection details.

For Supabase local development you can also use `supabase start` / `supabase db reset`,
which applies the same SQL files. The CLI owns `auth.users`; the migration only
references it.

## Security model

- **RLS is enabled on every table.** There are no `INSERT`, `UPDATE` or `DELETE`
  policies for `anon` or `authenticated`. All writes go through the trusted
  server using the service role, which bypasses RLS.
- **Public reads:** `clubs` and `players` grant `SELECT` to `anon` and
  `authenticated` with `USING (true)`. They contain only non-private, syncable data.
- **User-scoped reads:** `profiles` is readable by the owner, plus global staff
  (`owner`/`admin`/`staff`) via `user_roles`.
- **Club-scoped reads:** `club_private`, `club_memberships`, `guild_settings`,
  `staff_members`, `competitions` and `competition_entries` are readable by
  authenticated users with a global staff role or a matching club-scoped role.
  `blacklists` and `audit_logs` are global-staff only. The checks are enforced
  with `SECURITY DEFINER` helpers so clients do not need direct access to `user_roles`.
- **Service-role only:** `sync_runs`, `membership_events`, `club_snapshots`,
  `player_snapshots`, `notifications`, `user_roles`, `discord_users`,
  `guild_role_mappings` and `guild_custom_roles` have no client policies.
  `guild_custom_roles` explicitly revokes `anon`/`authenticated` grants. Future
  changes may add narrowly scoped SELECT policies for club history, but should
  keep them role-restricted.
- **No Discord OAuth tokens are stored anywhere.** `profiles` and `discord_users`
  hold only IDs, usernames and avatar URLs. Tokens stay in the trusted server/session
  layer (see root `.env.example`).

## Notes / assumptions

- Supabase manages `auth.users`; the `profiles.id` FK uses `ON DELETE CASCADE`.
- `pgcrypto` is installed for UUID generation (`gen_random_uuid()`).
- `membership_events` uses `UNIQUE NULLS NOT DISTINCT` (Postgres 15+) so retried
  syncs cannot duplicate events; `club_memberships` uses a partial unique index
  to allow exactly one open membership per player.
- `notifications.event_id` is a logical identifier (no polymorphic FK); the
  `(event_id, channel_id, kind)` unique key deduplicates Discord messages.
- Optional FKs (`created_by`, `granted_by`, `from_club_id`, `to_club_id`, etc.)
  use `ON DELETE SET NULL` so history survives entity deletion where sensible.
