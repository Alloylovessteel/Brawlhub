# Discord slash-command migration

BrawlHub now registers **20 top-level slash commands** instead of **42**. The change affects the Discord slash-command picker only. The underlying features, permissions, data sources and message components are unchanged.

## What members need to know

- Retired top-level names no longer appear in Discord’s slash-command picker. Use the replacement paths below.
- Buttons and select menus on existing messages still work. Their custom IDs—including guild IDs, nonces, pagination state and the `club-overview` toggle/done controls—are unchanged, so old messages do not need to be reposted.
- Reports remain scheduled auto-posts. They are not posted immediately when the bot starts.
- Scheduled club logs now post two distinct outputs from stored official-API history: trophy-progression digests once per completed window (daily/weekly/season at 00:00 UTC) and a separate Members & Roles event log for joins, leaves and leadership changes. `/clubs clublogs preview` can still post the combined full-page PNG on demand.
- Sync and verification completion notices are posted as mention-safe embeds to the guild’s configured announcement or verification channel.
- Blacklist commands remain disabled and unregistered.

## Current 20 commands and the retired names they replace

| Current command | Retired top-level command(s) now found here |
| --- | --- |
| `/clubs` | `/club`, `/clubs`, `/club-members`, `/club-leaderboard`, `/club-log`, `/club-history`, `/club-compare`, `/view`, `/club-overview`, `/clublogs`, `/register-club`, `/remove-club` |
| `/me` | `/me` → `/me profile`; new `/me image` posts a public player card |
| `/brawlers` | `/brawlers`, `/brawler` |
| `/player` | `/player-history`, `/player-battles`, `/player-clubs`, `/player-compare` |
| `/leaderboard` | `/leaderboard` (unchanged) |
| `/events` | `/events` (unchanged) |
| `/competition` | `/competition` (unchanged) |
| `/members` | `/members`, `/member-history`, `/member-search` (roster, history and player/discord searches only) |
| `/verify` | `/verify`, `/account verify`, `/unverify-one`, `/unverify-all`, `/delete-me` |
| `/tag-set` | `/tag-set` staff link (formerly `/members tag-set`) |
| `/staff` | `/staff` (unchanged) |
| `/sync` | `/sync` (unchanged) |
| `/settings` | `/settings` (verified-role subcommands moved to `/verify`) |
| `/inactivity` | `/inactivity` (unchanged) |
| `/audit` | `/audit` (unchanged) |
| `/help` | `/help`, `/info`, `/ping` |
| `/fn` | `/fn` (unchanged) |
| `/auto` | `/auto` (unchanged) |
| `/update` | `/update` (unchanged) |
| `/club-roles` | `/club-roles` (unchanged) |

## Detailed replacement paths

### Club commands

| Before | Use instead |
| --- | --- |
| `/club tag:…` | `/clubs details tag:…` |
| `/clubs` | `/clubs overview` |
| `/club-members tag:…` | `/clubs members tag:…` |
| `/club-leaderboard …` | `/clubs leaderboard …` |
| `/club-log tag:… period:…` | `/clubs log tag:… period:…` |
| `/club-history tag:…` | `/clubs history tag:…` |
| `/club-compare first:… second:…` | `/clubs compare first:… second:…` |
| `/view add|remove|list` | `/clubs view add|remove|list` |
| `/club-overview menu` | `/clubs fields` |
| `/clublogs add|remove|list` | `/clubs clublogs add|remove|list` with optional `period:` on `add`/`remove` (new: `/clubs clublogs preview`) |
| `/register-club tag:…` | `/clubs register tag:…` |
| `/remove-club club:…` | `/clubs remove club:…` |

### Player commands

| Before | Use instead |
| --- | --- |
| `/me [tag:…]` | `/me profile [tag:…]` |
| — | `/me image [tag:…]` posts a public player profile card |
| `/player-history tag:…` | `/player history tag:…` |
| `/player-battles tag:…` | `/player battles tag:…` |
| `/player-clubs tag:…` | `/player clubs tag:…` |
| `/player-compare first:… second:…` | `/player compare first:… second:…` |
| `/brawlers [tag:…] [sort:…] [filter:…]` | `/brawlers list [tag:…] [sort:…] [filter:…]` |
| `/brawler name:… [tag:…]` | `/brawlers detail name:… [tag:…]` |

### Member, verification and identity commands

| Before | Use instead |
| --- | --- |
| `/members tag:…` | `/members roster tag:…` |
| `/account list` | `/verify accounts list` |
| `/account set-main tag:…` | `/verify accounts set-main tag:…` |
| `/account verify start|check|cancel|status` | `/verify tag tag:…` / `/verify check` / `/verify cancel` / `/verify status` |
| `/verify info|settings|list` | `/verify info` / `/verify settings` / `/verify list` |
| `/verify tag set …` | `/tag-set …` |
| `/verify find user|tag …` | `/verify find user|tag …` |
| `/unverify-one user|tag …` | `/verify unverify-one user|tag …` |
| `/unverify-all user:…` | `/verify unverify-all user:…` |
| `/delete-me` | `/verify delete-me` |
| `/settings set-verified-role role:…` | `/verify set-verified-role role:…` |
| `/settings clear-verified-role` | `/verify clear-verified-role` |
| `/member-history tag:…` | `/members history tag:…` |
| `/member-search player query:…` | `/members find player query:…` |
| `/member-search discord user:…` | `/members find discord user:…` |

### Information commands

| Before | Use instead |
| --- | --- |
| `/help` | `/help directory` |
| `/info about|status` | `/help about|status` |
| `/ping` | `/help ping` |

## Automation added with this build

- `/clubs clublogs preview club:<club-uuid> [period:today|week|season]` requires `clubs:write` and only accepts a log configured for the current guild. It acknowledges privately, then posts the combined full-page PNG publicly in that channel without components.
- Scheduled club-log posts use the existing configured log channels. Stored history is included, so a newly added Members & Roles log backfills past changes once. Change events are marked delivered under the legacy `today` key after their PNG posts successfully, so failures stay queued for retry without republishing old ledger rows.
- Trophy digests are separate, trophy-only PNGs posted once per completed UTC window: Daily at 00:00, Weekly on Monday 00:00, Season at the first midnight after `BRAWL_SEASON_END_ISO`. Migration `0033_club_log_digest_posts.sql` adds the per-guild/per-log/per-period/per-window ledger that makes the 60-second digest poll restart-safe. Members without a baseline are never shown as `+0`.
- Club-log PNGs are not live and never use BrawlAPI/Brawlify as a data source.
- Operator notices reuse guild settings: sync uses the announcement channel with verification fallback; verification uses the verification channel with announcement fallback. All notices disable Discord mentions and are best-effort so they cannot fail a sync or verification.
- Report posts remain scheduled-only (`REPORTS_IMMEDIATE_ON_START=false`). Migrations `0032` (period-scoped deliveries) and `0033` (digest posts) must be applied before the split schedule is live.

All other top-level commands keep the same name, options and permissions.
