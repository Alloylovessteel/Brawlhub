# Discord slash-command migration

BrawlHub now registers **18 top-level slash commands** instead of **42**. The change affects the Discord slash-command picker only. The underlying features, permissions, data sources and message components are unchanged.

## What members need to know

- Retired top-level names no longer appear in Discord’s slash-command picker. Use the replacement paths below.
- Buttons and select menus on existing messages still work. Their custom IDs—including guild IDs, nonces, pagination state and the `club-overview` toggle/done controls—are unchanged, so old messages do not need to be reposted.
- Reports remain scheduled auto-posts. They are not posted immediately when the bot starts.
- Scheduled club logs now post one full-page PNG from stored official-API history; `/clubs clublogs preview` can post the same page on demand.
- Sync and verification completion notices are posted as mention-safe embeds to the guild’s configured announcement or verification channel.
- Blacklist commands remain disabled and unregistered.

## Current 18 commands and the retired names they replace

| Current command | Retired top-level command(s) now found here |
| --- | --- |
| `/clubs` | `/club`, `/clubs`, `/club-members`, `/club-leaderboard`, `/club-log`, `/club-history`, `/club-compare`, `/view`, `/club-overview`, `/clublogs`, `/register-club`, `/remove-club` |
| `/me` | `/me` → `/me profile`; new `/me image` posts a public player card |
| `/brawlers` | `/brawlers`, `/brawler` |
| `/player` | `/player-history`, `/player-battles`, `/player-clubs`, `/player-compare` |
| `/leaderboard` | `/leaderboard` (unchanged) |
| `/events` | `/events` (unchanged) |
| `/competition` | `/competition` (unchanged) |
| `/members` | `/members`, `/account`, `/verify`, `/unverify-one`, `/unverify-all`, `/delete-me`, `/member-history`, `/member-search` |
| `/staff` | `/staff` (unchanged) |
| `/sync` | `/sync` (unchanged) |
| `/settings` | `/settings` (unchanged) |
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
| `/clublogs add|remove|list` | `/clubs clublogs add|remove|list` (new: `/clubs clublogs preview`) |
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

### Member and identity commands

| Before | Use instead |
| --- | --- |
| `/members tag:…` | `/members roster tag:…` |
| `/account list` | `/members accounts list` |
| `/account set-main tag:…` | `/members accounts set-main tag:…` |
| `/account verify start|check|cancel|status` | `/members accounts verify|check|cancel|status` |
| `/verify info|settings|list` | `/members verify-info|verify-settings|register-list` |
| `/verify tag set …` | `/members tag set …` |
| `/verify find user|tag …` | `/members find user|tag …` |
| `/unverify-one user|tag …` | `/members unverify-one user|tag …` |
| `/unverify-all user:…` | `/members unverify-all user:…` |
| `/delete-me` | `/members delete-me` |
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

- `/clubs clublogs preview club:<club-uuid> [period:today|week|season]` requires `clubs:write` and only accepts a log configured for the current guild. It acknowledges privately, then posts the full-page PNG publicly in that channel without components.
- Scheduled club-log posts use the existing configured log channels and delivery watermark. A change is marked delivered only after its PNG is posted successfully; failures remain queued for retry.
- Club-log PNGs combine the selected stored trophy-progression period with recent stored membership, role and capacity changes. They are not live and never use BrawlAPI event rotation data.
- Operator notices reuse guild settings: sync uses the announcement channel with verification fallback; verification uses the verification channel with announcement fallback. All notices disable Discord mentions and are best-effort so they cannot fail a sync or verification.
- Report posts remain scheduled-only (`REPORTS_IMMEDIATE_ON_START=false`). No new migration or database schema is required for these features.

All other top-level commands keep the same name, options and permissions.
