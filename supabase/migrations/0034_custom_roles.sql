-- Additive: guild-scoped custom BrawlHub roles with explicit permission sets,
-- plus an optional custom-role target on Discord role mappings. Migrations
-- 0001-0033 and guild_settings.primary_club_id are untouched.

CREATE TABLE IF NOT EXISTS public.guild_custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  description text,
  permissions text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_custom_roles_guild_name_key UNIQUE (guild_id, name),
  -- Required as the target of the composite FK from guild_role_mappings.
  CONSTRAINT guild_custom_roles_guild_id_key UNIQUE (guild_id, id),
  CONSTRAINT guild_custom_roles_permissions_check CHECK (
    permissions <@ ARRAY[
      'clubs:read',
      'clubs:write',
      'players:read',
      'sync:run',
      'members:verify',
      'staff:manage',
      'competitions:manage',
      'blacklists:manage',
      'audit:read',
      'notifications:send'
    ]::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_guild_custom_roles_guild_id
  ON public.guild_custom_roles (guild_id);

DROP TRIGGER IF EXISTS trg_guild_custom_roles_updated_at ON public.guild_custom_roles;
CREATE TRIGGER trg_guild_custom_roles_updated_at
  BEFORE UPDATE ON public.guild_custom_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.guild_custom_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_custom_roles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_custom_roles TO service_role;

COMMENT ON TABLE public.guild_custom_roles IS
  'Guild-scoped custom BrawlHub roles that Discord roles can be mapped to. Service role only.';
COMMENT ON COLUMN public.guild_custom_roles.permissions IS
  'Explicit subset of BrawlHub permissions granted by this custom role.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'guild_custom_roles'
      AND p.polname = 'deny_anon_authenticated_all'
  ) THEN
    CREATE POLICY deny_anon_authenticated_all ON public.guild_custom_roles
      AS PERMISSIVE FOR ALL TO anon, authenticated
      USING (false) WITH CHECK (false);
  END IF;
END $$;

-- Existing built-in mappings keep their brawlhub_role value. New custom-role
-- mappings leave it NULL and set custom_role_id instead.
ALTER TABLE public.guild_role_mappings
  ALTER COLUMN brawlhub_role DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS custom_role_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.guild_role_mappings'::regclass
      AND conname = 'guild_role_mappings_target_check'
  ) THEN
    ALTER TABLE public.guild_role_mappings
      ADD CONSTRAINT guild_role_mappings_target_check CHECK (
        (brawlhub_role IS NOT NULL AND custom_role_id IS NULL)
        OR
        (brawlhub_role IS NULL AND custom_role_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.guild_role_mappings'::regclass
      AND conname = 'guild_role_mappings_custom_role_fk'
  ) THEN
    ALTER TABLE public.guild_role_mappings
      ADD CONSTRAINT guild_role_mappings_custom_role_fk
      FOREIGN KEY (guild_id, custom_role_id)
      REFERENCES public.guild_custom_roles (guild_id, id)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_guild_role_mappings_custom_role
  ON public.guild_role_mappings (guild_id, custom_role_id);

COMMENT ON COLUMN public.guild_role_mappings.brawlhub_role IS
  'Built-in BrawlHub role for this mapping; NULL when custom_role_id is set.';
COMMENT ON COLUMN public.guild_role_mappings.custom_role_id IS
  'Guild-local custom role; composite FK guarantees the same guild_id.';
