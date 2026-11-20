-- Additive: safe club archival and per-guild overview view tags.
-- Archiving is an UPDATE, never a DELETE, so snapshots, memberships, roles and
-- history remain attached to the club row.
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text;

-- The old (guild_id, tag) constraint prevents re-registering a tag after archival.
-- Replace it with an active-only unique index so the same tag can be tracked again
-- without discarding the archived row and its history.
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_guild_tag_key;
CREATE UNIQUE INDEX IF NOT EXISTS clubs_guild_tag_active_key
  ON public.clubs (guild_id, tag)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clubs_active_guild
  ON public.clubs (guild_id)
  WHERE archived_at IS NULL;

-- Archived clubs are not public. Bot/sync use the service role and must still add
-- explicit archived_at filters; RLS is defence in depth for browser clients.
DROP POLICY IF EXISTS clubs_public_select ON public.clubs;
CREATE POLICY clubs_public_select ON public.clubs
  FOR SELECT TO anon, authenticated
  USING (archived_at IS NULL);

-- Guild view tags: the explicit list of registered clubs a server shows in its
-- auto-posted overview. Empty means "show every active registered club" so that
-- existing guilds keep their current overview until staff choose a subset.
CREATE TABLE IF NOT EXISTS public.guild_view_tags (
  guild_id text NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  added_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_view_tags_guild ON public.guild_view_tags (guild_id);

ALTER TABLE public.guild_view_tags ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policy: view tags are written by the service-role bot only.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
REVOKE ALL ON TABLE public.guild_view_tags FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_view_tags TO service_role;
