# Discord slash-command migration

BrawlHub now registers **18 top-level slash commands** instead of **42**. The change affects the Discord slash-command picker only. The underlying features, permissions, data sources and message components are unchanged.

## What members need to know

- Retired top-level names no longer appear in Discord’s slash-command picker. Use the replacement paths below.
- Buttons and select menus on existing messages still work. Their custom IDs—including guild IDs, nonces, pagination state and the `club-overview` toggle/done controls—are unchanged, so old messages do not need to be reposted.
- Reports remain scheduled auto-posts. They are not posted immediately when the bot starts.
- Blacklist commands remain disabled and unregistered.

## Current 18 commands and the retired names they replace

| Current command | Retired top-level command(s) now found here |
| --- | --- |
| `/clubs` | `/club`, `/clubs`, `/club-members`, `/club-leaderboard`, `/club-log`, `/club-history`, `/club-compare`, `/view`, `/club-overview`, `/clublogs`, `/register-club`, `/remove-club` |
| `/me` | `/me` (unchanged) |
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
| `/clublogs add|remove|list` | `/clubs logs add|remove|list` |
| `/register-club tag:…` | `/clubs register tag:…` |
| `/remove-club club:…` | `/clubs remove club:…` |

### Player commands

| Before | Use instead |
| --- | --- |
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
| `/account list` | `/members account list` |
| `/account set-main tag:…` | `/members account set-main tag:…` |
| `/account verify start|check|cancel|status` | `/members account verify-start|verify-check|verify-cancel|verify-status` |
| `/verify info|settings|list` | `/members verify info|settings|list` |
| `/verify tag set …` | `/members verify tag-set …` |
| `/verify find user|tag …` | `/members verify find-user|find-tag …` |
| `/unverify-one user|tag …` | `/members unverify-one user|tag …` |
| `/unverify-all user:…` | `/members unverify-all user:…` |
| `/delete-me` | `/members delete-me` |
| `/member-history tag:…` | `/members history tag:…` |
| `/member-search player query:…` | `/members search player query:…` |
| `/member-search discord user:…` | `/members search discord user:…` |

### Information commands

| Before | Use instead |
| --- | --- |
| `/help` | `/help directory` |
| `/info about|status` | `/help about|status` |
| `/ping` | `/help ping` |

All other top-level commands keep the same name, options and permissions.
