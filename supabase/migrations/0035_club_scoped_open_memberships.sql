-- Clubs are registered per guild, so the same real club (and the same player)
-- can be tracked independently by multiple servers. The legacy unique index
-- allowed only one open membership per player across the whole database, which
-- made a second guild's sync fail or close another guild's membership row.
-- Scope open membership uniqueness to (player, club) instead. Existing data
-- already satisfies this weaker constraint, and no history rows are changed.

DROP INDEX IF EXISTS public.uq_club_memberships_open_player;

CREATE UNIQUE INDEX IF NOT EXISTS uq_club_memberships_open_player_club
  ON public.club_memberships (player_id, club_id)
  WHERE valid_to IS NULL;

COMMENT ON INDEX public.uq_club_memberships_open_player_club IS
  'One open membership per player and per guild-owned club; different guilds can track the same player independently.';
