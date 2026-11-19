-- Per-guild Discord role to BrawlHub role mappings.
-- Allows Discord server administrators to configure which Discord roles grant
-- which BrawlHub permissions/roles within that guild.

CREATE TABLE IF NOT EXISTS public.guild_role_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  discord_role_id text NOT NULL,
  brawlhub_role text NOT NULL CHECK (brawlhub_role IN ('owner', 'admin', 'staff', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_role_mappings_guild_discord_role_key UNIQUE (guild_id, discord_role_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_role_mappings_guild_id
  ON public.guild_role_mappings (guild_id);

DROP TRIGGER IF EXISTS trg_guild_role_mappings_updated_at ON public.guild_role_mappings;
CREATE TRIGGER trg_guild_role_mappings_updated_at
  BEFORE UPDATE ON public.guild_role_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.guild_role_mappings ENABLE ROW LEVEL SECURITY;
-- No client policies: reads/writes are performed by trusted service-role clients.
