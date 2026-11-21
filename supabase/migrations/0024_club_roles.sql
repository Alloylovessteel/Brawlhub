-- Additive: per-guild mappings for Brawl Stars club-rank Discord roles.
-- Roles are assigned only from verified main accounts whose player is in a
-- club registered to the same guild. Empty mapping means the feature is off.

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS club_role_ids jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.guild_settings.club_role_ids IS
  'Map of Brawl Stars club ranks (president, vicePresident, senior) to Discord role IDs for this guild only.';
