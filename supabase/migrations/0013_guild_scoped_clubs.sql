-- Scope clubs and sync to Discord guilds so each server can maintain its own
-- separate set of registered clubs. Existing deployments must be empty of clubs
-- before applying, or backfill guild_id first.

ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS guild_id text;
UPDATE public.clubs SET guild_id = COALESCE(NULLIF(guild_id, ''), 'unknown') WHERE guild_id IS NULL OR guild_id = '';
ALTER TABLE public.clubs ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_tag_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clubs_guild_tag_key'
  ) THEN
    ALTER TABLE public.clubs ADD CONSTRAINT clubs_guild_tag_key UNIQUE (guild_id, tag);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_clubs_guild_id ON public.clubs (guild_id);
