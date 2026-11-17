# Phase 3 foundations: authentication, permissions and data access

This document records the Phase 3 foundation decisions before dashboard UI work begins. It is based on a review of the existing Next.js app, Supabase migrations, sync engine and Discord bot.

## Existing architecture confirmed

- Next.js 16 App Router, React 19, TypeScript strict mode, npm workspaces.
- Supabase Auth is already enabled with the Discord provider in `supabase/config.toml`.
- `apps/web/src/lib/supabase.ts` already creates a request-scoped Supabase client using the anonymous key and request cookies.
- `packages/shared/src/permissions.ts` already defines `Role`, `Permission`, `ROLE_PERMISSIONS` and `hasPermission()`.
- The initial migration already contains `profiles`, `discord_users`, `user_roles`, `guild_settings`, `staff_members` and `audit_logs`, plus SQL helpers `is_global_staff()` and `has_club_access()`.
- RLS is already enabled on the domain tables, but only SELECT policies exist and several history tables have no policies.
- The Phase 2 sync engine writes all real club, player, membership and snapshot data. Phase 3 will read that data only.

## Authentication design

Discord OAuth2 is handled by Supabase Auth.

1. `/login` starts `signInWithOAuth()` with scopes `identify email guilds` and a safe `redirectTo` of `/api/auth/callback`.
2. Supabase validates the OAuth `state`; the callback additionally validates that `code` is present and that any `next` parameter is a local relative path.
3. `/api/auth/callback` exchanges the code for a Supabase session.
4. The callback uses the provider access token to call Discord's `GET /users/@me/guilds`.
5. Access is denied unless the user is a member of `DISCORD_GUILD_ID`.
6. The callback provisions `profiles` and `discord_users` rows and refreshes `user_roles` using a trusted server-side client.
7. Middleware refreshes the Supabase session on every request and protects `/dashboard/*`.
8. Logout calls `supabase.auth.signOut()` and clears the session cookies.

Session cookies are managed by `@supabase/ssr`. They are HTTP-only, SameSite=Lax and Secure in production. Supabase handles expiry and refresh-token rotation; middleware applies the refreshed cookies before rendering protected pages.

No Discord bot token, Supabase service-role key or Brawl Stars API key is ever sent to the browser.

## Permission model

The existing four application roles are reused rather than adding a duplicate role system:

| Requested role | Stored representation | Scope |
|---|---|---|
| Server Owner | `owner` | global |
| Server Administrator | `admin` | global |
| Club President | `owner` | club |
| Club Staff | `staff` | club |
| Member | `member` | club |
| Guest | no row / no verified guild membership | none |

Role derivation is server-side and configurable:

- The Discord guild owner always receives global `owner`.
- `DISCORD_OWNER_ROLE_IDS` grants global `owner`.
- `DISCORD_ADMIN_ROLE_IDS` grants global `admin`.
- `DISCORD_ROLE_MAP` is a JSON object mapping club tags to `presidentRoleIds` and `staffRoleIds`.
- Verified guild members with no elevated mapping receive `member` for every registered club.
- Discord role IDs are validated as snowflakes before being trusted.
- Client-provided user IDs, club IDs and permission claims are never trusted.

Permissions are checked twice:

1. In application guards using `hasPermission()` and club-scoped role rows loaded from the database.
2. In Supabase RLS using `is_global_staff()` and `has_club_access()`.

Service-role reads are limited to trusted auth provisioning and admin APIs. Dashboard read queries use the user-scoped Supabase client so RLS remains effective.

## Data access design

A server-only data layer will expose reusable functions for:

- clubs and club lookups
- players and player lookups
- current memberships and membership history
- club snapshots and player snapshots
- membership events
- sync runs
- notifications
- roles, audit logs and guild settings for admins

All list queries support pagination and validated filters. Timestamp fields are preserved exactly as stored. Columns that Phase 2 does not populate, such as some player statistics, are rendered as unavailable rather than as zero.

Historical charts plot only real snapshot rows. The first/last available snapshot timestamps are displayed so users can see when collection began. Missing ranges produce an empty state rather than interpolated values.

## Immediate implementation sequence

1. Add Tailwind/shadcn-style UI foundation and fix the missing `@brawlhub/sync` web dependency.
2. Implement Discord OAuth2 callback, middleware, session helpers and role provisioning.
3. Add the RLS hardening migration and tests for role derivation/guards.
4. Build the shared data layer and dashboard shell.
5. Build club, player, leaderboard and history pages.
6. Add admin tools, audit logging, rate limiting and final verification.
