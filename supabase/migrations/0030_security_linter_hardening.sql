-- Supabase Security Advisor hardening. Additive only; migrations 0001-0029
-- remain untouched. Fixes:
--   * Auth RLS Initialization Plan (cache auth.*()/current_setting() per statement)
--   * Multiple Permissive Policies on public.profiles
--   * Function Search Path Mutable
--   * Public/Signed-In Users Can Execute SECURITY DEFINER Function
--
-- The authorization helpers are recreated as SECURITY DEFINER functions in a
-- schema that PostgREST never exposes. Public functions remain as SECURITY
-- INVOKER wrappers so existing RLS policies keep working unchanged.

CREATE SCHEMA IF NOT EXISTS brawlhub_private;
REVOKE ALL ON SCHEMA brawlhub_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA brawlhub_private TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Real helpers: private schema, SECURITY DEFINER, pinned search_path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION brawlhub_private.is_global_staff(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = p_user_id
      AND ur.scope = 'global'
      AND ur.role IN ('owner', 'admin', 'staff')
  );
$$;

CREATE OR REPLACE FUNCTION brawlhub_private.has_club_access(p_user_id uuid, p_club_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT brawlhub_private.is_global_staff(p_user_id)
    OR (
      p_club_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = p_user_id
          AND ur.scope = 'club'
          AND ur.club_id = p_club_id
          AND ur.role IN ('owner', 'admin', 'staff', 'member')
      )
    );
$$;

CREATE OR REPLACE FUNCTION brawlhub_private.has_competition_access(p_user_id uuid, p_competition_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT brawlhub_private.has_club_access(
    p_user_id,
    (SELECT c.club_id FROM public.competitions c WHERE c.id = p_competition_id)
  );
$$;

CREATE OR REPLACE FUNCTION brawlhub_private.is_global_owner(target_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = target_user_id
      AND scope = 'global'
      AND role = 'owner'
  );
$$;

CREATE OR REPLACE FUNCTION brawlhub_private.has_player_access(target_user_id uuid, target_player_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT brawlhub_private.is_global_staff(target_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.club_memberships cm
      WHERE cm.player_id = target_player_id
        AND brawlhub_private.has_club_access(target_user_id, cm.club_id)
    );
$$;

CREATE OR REPLACE FUNCTION brawlhub_private.is_current_user_global_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND scope = 'global'
      AND role IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION brawlhub_private.is_global_staff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION brawlhub_private.has_club_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION brawlhub_private.has_competition_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION brawlhub_private.is_global_owner(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION brawlhub_private.has_player_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION brawlhub_private.is_current_user_global_admin() FROM PUBLIC, anon;

-- The public wrappers are SECURITY INVOKER, so their callers need EXECUTE on
-- the private SECURITY DEFINER helpers. PostgREST cannot reach the private
-- schema because it is not listed in supabase/config.toml schemas.
GRANT EXECUTE ON FUNCTION brawlhub_private.is_global_staff(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION brawlhub_private.has_club_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION brawlhub_private.has_competition_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION brawlhub_private.is_global_owner(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION brawlhub_private.has_player_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION brawlhub_private.is_current_user_global_admin() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Public wrappers: same names/signatures, SECURITY INVOKER.
--    Existing RLS policies and app queries need no changes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_global_staff(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT brawlhub_private.is_global_staff(p_user_id); $$;

CREATE OR REPLACE FUNCTION public.has_club_access(p_user_id uuid, p_club_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT brawlhub_private.has_club_access(p_user_id, p_club_id); $$;

CREATE OR REPLACE FUNCTION public.has_competition_access(p_user_id uuid, p_competition_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT brawlhub_private.has_competition_access(p_user_id, p_competition_id); $$;

CREATE OR REPLACE FUNCTION public.is_global_owner(target_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT brawlhub_private.is_global_owner(target_user_id); $$;

CREATE OR REPLACE FUNCTION public.has_player_access(target_user_id uuid, target_player_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT brawlhub_private.has_player_access(target_user_id, target_player_id); $$;

CREATE OR REPLACE FUNCTION public.is_current_user_global_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT brawlhub_private.is_current_user_global_admin(); $$;

REVOKE ALL ON FUNCTION public.is_global_staff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_club_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_competition_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_global_owner(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_player_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_current_user_global_admin() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_global_staff(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_club_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_competition_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_global_owner(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_player_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_current_user_global_admin() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Collapse the two permissive public.profiles SELECT policies into one.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_select_global_staff ON public.profiles;
DROP POLICY IF EXISTS profiles_select_own_or_global_staff ON public.profiles;
CREATE POLICY profiles_select_own_or_global_staff
  ON public.profiles FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR public.is_global_staff((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 4. Cache auth.*()/current_setting() in every public RLS policy expression.
--    Rewriting is idempotent: already-cached calls are unwrapped first.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  v_using text;
  v_check text;
  v_new_using text;
  v_new_check text;
  v_roles text;
  v_sql text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        coalesce(qual, '') ~* '(auth\.[a-z0-9_]+\s*\(\s*\))|(current_setting\s*\()'
        OR coalesce(with_check, '') ~* '(auth\.[a-z0-9_]+\s*\(\s*\))|(current_setting\s*\()'
      )
  LOOP
    v_using := coalesce(r.qual, '');
    v_check := coalesce(r.with_check, '');

    -- Undo any previous wrapper so the rewrite cannot nest subselects.
    v_new_using := regexp_replace(
      v_using,
      '\(\s*select\s+((?:auth\.[a-z0-9_]+\s*\(\s*\))|(?:current_setting\s*\([^)]*\)))\s*\)',
      '\1',
      'gi'
    );
    v_new_check := regexp_replace(
      v_check,
      '\(\s*select\s+((?:auth\.[a-z0-9_]+\s*\(\s*\))|(?:current_setting\s*\([^)]*\)))\s*\)',
      '\1',
      'gi'
    );

    v_new_using := regexp_replace(
      v_new_using,
      '(auth\.[a-z0-9_]+\s*\(\s*\))',
      '(select \1)',
      'gi'
    );
    v_new_check := regexp_replace(
      v_new_check,
      '(auth\.[a-z0-9_]+\s*\(\s*\))',
      '(select \1)',
      'gi'
    );
    v_new_using := regexp_replace(
      v_new_using,
      '(current_setting\s*\([^)]*\))',
      '(select \1)',
      'gi'
    );
    v_new_check := regexp_replace(
      v_new_check,
      '(current_setting\s*\([^)]*\))',
      '(select \1)',
      'gi'
    );

    IF r.roles IS NULL OR cardinality(r.roles) = 0 OR r.roles = ARRAY['public']::name[] THEN
      v_roles := 'PUBLIC';
    ELSE
      SELECT string_agg(quote_ident(x.u::text), ', ' ORDER BY x.u)
      INTO v_roles
      FROM unnest(r.roles) AS x(u);
    END IF;

    v_sql := format(
      'ALTER POLICY %I ON %I.%I TO %s',
      r.policyname,
      r.schemaname,
      r.tablename,
      v_roles
    );

    IF r.qual IS NOT NULL AND v_new_using IS DISTINCT FROM v_using THEN
      v_sql := v_sql || format(' USING (%s)', v_new_using);
    END IF;
    IF r.with_check IS NOT NULL AND v_new_check IS DISTINCT FROM v_check THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', v_new_check);
    END IF;

    EXECUTE v_sql;
    RAISE NOTICE 'Cached auth calls in policy %.%', r.schemaname, r.policyname;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Pin search_path on every function in the exposed schemas.
--    The six helpers above are already pinned; this covers the rest.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'brawlhub_private')
      AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, pg_temp',
      r.nspname,
      r.proname,
      r.args
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Any remaining public SECURITY DEFINER function is service-role-only.
--    Remove implicit/default grants from anon and authenticated.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')
      AND p.prosecdef = true
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated',
      r.nspname,
      r.proname,
      r.args
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role',
      r.nspname,
      r.proname,
      r.args
    );
  END LOOP;
END $$;
