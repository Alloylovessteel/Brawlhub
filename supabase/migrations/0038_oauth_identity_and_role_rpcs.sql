-- OAuth identity handoff and manual role changes must be atomic.
--
-- A Discord OAuth login can arrive after the bot created a shadow profile for
-- the same Discord id. The profile claim previously renamed the shadow row and
-- moved role grants in separate requests, leaving active player verifications
-- behind on the retired id. Role administration was also a check-then-write
-- outside the database, so a concurrent grant change could invalidate the
-- authorization decision. These service-role-only RPCs keep each transition in
-- one transaction and preserve a stable reference to the retired identity.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS replaced_by_profile_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaced_at timestamptz;

ALTER TABLE public.discord_users
  ADD COLUMN IF NOT EXISTS previous_profile_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_replaced_by
  ON public.profiles (replaced_by_profile_id)
  WHERE replaced_by_profile_id IS NOT NULL;

COMMENT ON COLUMN public.profiles.replaced_by_profile_id IS
  'Profile that took over this Discord identity after an OAuth handoff.';
COMMENT ON COLUMN public.discord_users.previous_profile_id IS
  'Profile that previously owned this Discord id before an OAuth handoff.';

-- Same policy as the web role-admin helper, re-evaluated inside the RPC.
CREATE OR REPLACE FUNCTION public.brawlhub_can_administer_role(
  p_global_role text,
  p_club_role text,
  p_scope text,
  p_target_role text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_global_role = 'owner' THEN
      CASE WHEN p_scope = 'global' THEN true
           ELSE p_target_role IN ('owner', 'staff', 'member') END
    WHEN p_global_role = 'admin' THEN
      p_scope = 'club' AND p_target_role IN ('staff', 'member')
    ELSE
      p_scope = 'club' AND p_club_role = 'owner' AND p_target_role IN ('staff', 'member')
  END;
$$;

REVOKE ALL ON FUNCTION public.brawlhub_can_administer_role(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.brawlhub_can_administer_role(text, text, text, text) TO service_role;

/**
 * Claim a bot-created shadow identity for an authenticated profile.
 *
 * Locking the Discord id serializes competing OAuth callbacks. Shadow roles
 * and active verifications move to the authenticated profile in this same
 * transaction; duplicate player links are revoked rather than left stranded.
 */
CREATE OR REPLACE FUNCTION public.claim_bot_identity(
  p_auth_user_id uuid,
  p_discord_user_id text,
  p_username text,
  p_avatar_url text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shadow_id uuid;
  v_shadow_discord_id text;
  v_target_main_id uuid;
  v_role record;
  v_moved_verifications integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('claim_bot_identity:' || p_discord_user_id));

  SELECT p.id
    INTO v_shadow_id
    FROM public.profiles p
   WHERE p.discord_user_id = p_discord_user_id
     AND p.id <> p_auth_user_id
   ORDER BY p.id
   LIMIT 1
   FOR UPDATE;

  IF v_shadow_id IS NOT NULL THEN
    v_shadow_discord_id := 'shadow:' || p_auth_user_id::text;
    WHILE EXISTS (
      SELECT 1
        FROM public.profiles p
       WHERE p.discord_user_id = v_shadow_discord_id
         AND p.id <> v_shadow_id
    ) LOOP
      v_shadow_discord_id := v_shadow_discord_id || ':retry';
    END LOOP;

    UPDATE public.profiles p
       SET discord_user_id = v_shadow_discord_id,
           replaced_by_profile_id = p_auth_user_id,
           replaced_at = now()
     WHERE p.id = v_shadow_id;
  END IF;

  INSERT INTO public.profiles (id, discord_user_id, username, avatar_url)
  VALUES (p_auth_user_id, p_discord_user_id, p_username, p_avatar_url)
  ON CONFLICT (id) DO UPDATE
     SET discord_user_id = EXCLUDED.discord_user_id,
         username = COALESCE(EXCLUDED.username, public.profiles.username),
         avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url);

  -- A profile can only be the primary owner of one Discord directory row.
  UPDATE public.discord_users
     SET profile_id = NULL,
         updated_at = now()
   WHERE profile_id = p_auth_user_id
     AND discord_user_id <> p_discord_user_id;

  INSERT INTO public.discord_users (discord_user_id, profile_id, username, avatar_url)
  VALUES (p_discord_user_id, p_auth_user_id, p_username, p_avatar_url)
  ON CONFLICT (discord_user_id) DO UPDATE
     SET profile_id = EXCLUDED.profile_id,
         previous_profile_id = public.discord_users.profile_id,
         username = EXCLUDED.username,
         avatar_url = EXCLUDED.avatar_url
   WHERE public.discord_users.profile_id IS DISTINCT FROM EXCLUDED.profile_id;

  IF v_shadow_id IS NOT NULL THEN
    FOR v_role IN
      SELECT r.scope, r.club_id, r.role, r.source, r.granted_by
        FROM public.user_roles r
       WHERE r.user_id = v_shadow_id
    LOOP
      INSERT INTO public.user_roles (user_id, scope, club_id, role, source, granted_by)
      VALUES (p_auth_user_id, v_role.scope, v_role.club_id, v_role.role, v_role.source, v_role.granted_by)
      ON CONFLICT (user_id, scope, club_id) DO UPDATE
         SET role = EXCLUDED.role,
             source = EXCLUDED.source,
             granted_by = EXCLUDED.granted_by
       WHERE public.user_roles.source = 'discord';
    END LOOP;
    DELETE FROM public.user_roles r WHERE r.user_id = v_shadow_id;

    SELECT v.id
      INTO v_target_main_id
      FROM public.player_verifications v
     WHERE v.profile_id = p_auth_user_id
       AND v.status = 'active'
       AND v.is_main
     ORDER BY v.verified_at, v.created_at, v.id
     LIMIT 1;

    UPDATE public.player_verifications shadow
       SET status = 'revoked',
           revoked_at = now(),
           revoked_by_profile_id = p_auth_user_id,
           is_main = false
     WHERE shadow.profile_id = v_shadow_id
       AND shadow.status = 'active'
       AND EXISTS (
         SELECT 1
           FROM public.player_verifications target
          WHERE target.profile_id = p_auth_user_id
            AND target.player_id = shadow.player_id
            AND target.status = 'active'
       );

    UPDATE public.player_verifications v
       SET is_main = false
     WHERE v.profile_id = p_auth_user_id
       AND v.status = 'active'
       AND v.is_main;

    UPDATE public.player_verifications v
       SET profile_id = p_auth_user_id,
           is_main = false,
           verified_by_profile_id = COALESCE(v.verified_by_profile_id, p_auth_user_id)
     WHERE v.profile_id = v_shadow_id
       AND v.status = 'active';
    GET DIAGNOSTICS v_moved_verifications = ROW_COUNT;

    IF v_target_main_id IS NOT NULL THEN
      UPDATE public.player_verifications v
         SET is_main = true
       WHERE v.id = v_target_main_id
         AND v.profile_id = p_auth_user_id
         AND v.status = 'active';
    ELSE
      UPDATE public.player_verifications v
         SET is_main = true
        FROM (
          SELECT candidate.id
            FROM public.player_verifications candidate
           WHERE candidate.profile_id = p_auth_user_id
             AND candidate.status = 'active'
           ORDER BY candidate.verified_at, candidate.created_at, candidate.id
           LIMIT 1
        ) chosen
       WHERE v.id = chosen.id;
    END IF;

    INSERT INTO public.audit_logs (actor_profile_id, action, target_type, target_id, details)
    VALUES (
      p_auth_user_id,
      'identity.claimed',
      'profile',
      v_shadow_id::text,
      jsonb_build_object(
        'discordUserId', p_discord_user_id,
        'shadowProfileId', v_shadow_id,
        'verificationsMoved', v_moved_verifications
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'shadowProfileId', v_shadow_id,
    'verificationsMoved', v_moved_verifications
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_bot_identity(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bot_identity(uuid, text, text, text) TO service_role;

/**
 * Reconcile Discord-derived grants while trusting current manual grants.
 *
 * The lock covers the read-delete-upsert sequence, and manual rows are never
 * deleted or overwritten by an OAuth refresh.
 */
CREATE OR REPLACE FUNCTION public.refresh_discord_role_grants(
  p_profile_id uuid,
  p_grants jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grant jsonb;
  v_scope text;
  v_club_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('refresh_discord_role_grants:' || p_profile_id::text));

  DELETE FROM public.user_roles r
   WHERE r.user_id = p_profile_id
     AND r.source = 'discord'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_grants) supplied
        WHERE supplied->>'scope' = r.scope
          AND NULLIF(supplied->>'clubId', '')::uuid IS NOT DISTINCT FROM r.club_id
     );

  FOR v_grant IN SELECT value FROM jsonb_array_elements(p_grants) LOOP
    v_scope := v_grant->>'scope';
    v_club_id := NULLIF(v_grant->>'clubId', '')::uuid;
    IF v_scope = 'global' THEN
      v_club_id := NULL;
    END IF;

    INSERT INTO public.user_roles (user_id, scope, club_id, role, source, granted_by)
    VALUES (p_profile_id, v_scope, v_club_id, v_grant->>'role', 'discord', NULL)
    ON CONFLICT (user_id, scope, club_id) DO UPDATE
       SET role = EXCLUDED.role,
           source = EXCLUDED.source,
           granted_by = EXCLUDED.granted_by
     WHERE public.user_roles.source = 'discord';
  END LOOP;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_discord_role_grants(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_discord_role_grants(uuid, jsonb) TO service_role;

/**
 * Validate and apply a manual role change under one transaction.
 *
 * Actor/target roles and club state are re-read after taking the lock, and the
 * audit row is written by the same transaction so a saved grant can never be
 * reported as a failed change because audit logging failed afterwards.
 */
CREATE OR REPLACE FUNCTION public.apply_manual_role_change(
  p_actor_profile_id uuid,
  p_discord_user_id text,
  p_scope text,
  p_club_id uuid,
  p_role text,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_id uuid;
  v_guild_id text;
  v_actor_global_role text;
  v_actor_club_role text;
  v_existing_roles text[];
  v_role text;
  v_allowed boolean := true;
BEGIN
  IF p_scope NOT IN ('global', 'club')
     OR p_role NOT IN ('owner', 'admin', 'staff', 'member')
     OR p_action NOT IN ('grant', 'revoke')
     OR (p_scope = 'global' AND p_club_id IS NOT NULL)
     OR (p_scope = 'club' AND p_club_id IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('apply_manual_role_change:' || p_discord_user_id || ':' || p_scope || ':' || COALESCE(p_club_id::text, ''))
  );

  SELECT p.id INTO v_target_id
    FROM public.profiles p
   WHERE p.discord_user_id = p_discord_user_id;
  IF v_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_target');
  END IF;

  IF p_action = 'revoke' AND p_scope = 'global' AND p_role = 'owner'
     AND v_target_id = p_actor_profile_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cannot_revoke_self');
  END IF;

  IF p_scope = 'club' THEN
    SELECT c.guild_id INTO v_guild_id
      FROM public.clubs c
     WHERE c.id = p_club_id
       AND c.archived_at IS NULL;
    IF v_guild_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_club');
    END IF;
  END IF;

  SELECT r.role INTO v_actor_global_role
    FROM public.user_roles r
   WHERE r.user_id = p_actor_profile_id
     AND r.scope = 'global'
     AND r.club_id IS NULL
   ORDER BY CASE r.role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'staff' THEN 2 ELSE 1 END DESC
   LIMIT 1;

  SELECT r.role INTO v_actor_club_role
    FROM public.user_roles r
   WHERE r.user_id = p_actor_profile_id
     AND r.scope = 'club'
     AND r.club_id = p_club_id
   ORDER BY CASE r.role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'staff' THEN 2 ELSE 1 END DESC
   LIMIT 1;

  SELECT array_agg(r.role ORDER BY r.role) INTO v_existing_roles
    FROM public.user_roles r
   WHERE r.user_id = v_target_id
     AND r.scope = p_scope
     AND r.club_id IS NOT DISTINCT FROM p_club_id;

  v_allowed := public.brawlhub_can_administer_role(
    v_actor_global_role, v_actor_club_role, p_scope, p_role
  );
  IF v_allowed THEN
    FOREACH v_role IN ARRAY COALESCE(v_existing_roles, ARRAY[]::text[]) LOOP
      v_allowed := v_allowed AND public.brawlhub_can_administer_role(
        v_actor_global_role, v_actor_club_role, p_scope, v_role
      );
      IF NOT v_allowed THEN EXIT; END IF;
    END LOOP;
  END IF;
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  IF p_action = 'grant' THEN
    INSERT INTO public.user_roles (user_id, scope, club_id, role, source, granted_by)
    VALUES (v_target_id, p_scope, p_club_id, p_role, 'manual', p_actor_profile_id)
    ON CONFLICT (user_id, scope, club_id) DO UPDATE
       SET role = EXCLUDED.role,
           source = EXCLUDED.source,
           granted_by = EXCLUDED.granted_by;
  ELSE
    DELETE FROM public.user_roles r
     WHERE r.user_id = v_target_id
       AND r.scope = p_scope
       AND r.club_id IS NOT DISTINCT FROM p_club_id;
  END IF;

  INSERT INTO public.audit_logs (actor_profile_id, action, target_type, target_id, guild_id, details)
  VALUES (
    p_actor_profile_id,
    CASE WHEN p_action = 'grant' THEN
      CASE WHEN p_scope = 'club' THEN 'club.staff.granted' ELSE 'role.granted' END
    ELSE
      CASE WHEN p_scope = 'club' THEN 'club.staff.revoked' ELSE 'role.revoked' END
    END,
    'profile',
    v_target_id::text,
    v_guild_id,
    jsonb_build_object(
      'discordUserId', p_discord_user_id,
      'scope', p_scope,
      'role', p_role,
      'clubId', p_club_id
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_manual_role_change(uuid, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_manual_role_change(uuid, text, text, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.claim_bot_identity(uuid, text, text, text) IS
  'Atomically claim a Discord shadow profile, preserving roles, verifications and retired identity history.';
COMMENT ON FUNCTION public.refresh_discord_role_grants(uuid, jsonb) IS
  'Reconcile Discord-derived grants without deleting or overwriting current manual grants.';
COMMENT ON FUNCTION public.apply_manual_role_change(uuid, text, text, uuid, text, text) IS
  'Validate authorization and apply a manual role change with its audit row in one transaction.';
