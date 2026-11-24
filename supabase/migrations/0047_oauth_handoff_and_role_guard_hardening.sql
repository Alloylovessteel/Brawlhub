-- Corrective hardening for the 67e535f rescan findings 1-5.
--
-- 0038 is already applied, so these changes are additive. The identity claim
-- now creates the target profile before referencing it, recovers links left by
-- the earlier handoff, preserves the shadow's selected main account, and the
-- role RPC denies absent permissions and protects stored owner grants.

-- A missing role must be an explicit deny. COALESCE keeps the helper non-null
-- even if a caller supplies no stored role at all.
CREATE OR REPLACE FUNCTION public.brawlhub_can_administer_role(
  p_global_role text,
  p_club_role text,
  p_scope text,
  p_target_role text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE
      WHEN p_global_role = 'owner' THEN
        CASE WHEN p_scope = 'global' THEN true
             ELSE p_target_role IN ('owner', 'staff', 'member') END
      WHEN p_global_role = 'admin' THEN
        p_scope = 'club' AND p_target_role IN ('staff', 'member')
      ELSE
        p_scope = 'club' AND p_club_role = 'owner' AND p_target_role IN ('staff', 'member')
    END,
    false
  );
$$;

REVOKE ALL ON FUNCTION public.brawlhub_can_administer_role(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.brawlhub_can_administer_role(text, text, text, text) TO service_role;

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
  v_shadow_needs_rename boolean := false;
  v_shadow_discord_id text;
  v_shadow_main_player_id uuid;
  v_target_main_id uuid;
  v_role record;
  v_moved_verifications integer := 0;
  v_recovered boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('claim_bot_identity:' || p_discord_user_id));

  -- The first branch is the normal handoff: a bot shadow still owns the real
  -- Discord id. The other branches recover accounts processed by the earlier
  -- implementation, which renamed the shadow before handing off its roles.
  SELECT p.id, p.discord_user_id = p_discord_user_id
    INTO v_shadow_id, v_shadow_needs_rename
    FROM public.profiles p
   WHERE p.id <> p_auth_user_id
     AND (
       p.discord_user_id = p_discord_user_id
       OR (
         p.replaced_by_profile_id = p_auth_user_id
         AND p.discord_user_id <> p_discord_user_id
       )
       OR EXISTS (
         SELECT 1
           FROM public.discord_users du
          WHERE du.discord_user_id = p_discord_user_id
            AND du.profile_id = p_auth_user_id
            AND du.previous_profile_id = p.id
       )
     )
   ORDER BY CASE WHEN p.discord_user_id = p_discord_user_id THEN 0 ELSE 1 END, p.id
   LIMIT 1
   FOR UPDATE OF p;

  IF v_shadow_id IS NOT NULL AND v_shadow_needs_rename THEN
    v_shadow_discord_id := 'shadow:' || p_auth_user_id::text;
    WHILE EXISTS (
      SELECT 1
        FROM public.profiles p
       WHERE p.discord_user_id = v_shadow_discord_id
         AND p.id <> v_shadow_id
    ) LOOP
      v_shadow_discord_id := v_shadow_discord_id || ':retry';
    END LOOP;

    -- Free the unique Discord id first, but do not point at the target until
    -- the target profile exists; replaced_by_profile_id is an immediate FK.
    UPDATE public.profiles p
       SET discord_user_id = v_shadow_discord_id
     WHERE p.id = v_shadow_id;
  END IF;

  INSERT INTO public.profiles (id, discord_user_id, username, avatar_url)
  VALUES (p_auth_user_id, p_discord_user_id, p_username, p_avatar_url)
  ON CONFLICT (id) DO UPDATE
     SET discord_user_id = EXCLUDED.discord_user_id,
         username = COALESCE(EXCLUDED.username, public.profiles.username),
         avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url);

  IF v_shadow_id IS NOT NULL THEN
    v_recovered := NOT v_shadow_needs_rename;
    UPDATE public.profiles p
       SET replaced_by_profile_id = p_auth_user_id,
           replaced_at = COALESCE(p.replaced_at, now())
     WHERE p.id = v_shadow_id;
  END IF;

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

    -- Remember which account the shadow had selected before the move. It is
    -- the default replacement when the target has no main of its own.
    SELECT v.player_id
      INTO v_shadow_main_player_id
      FROM public.player_verifications v
     WHERE v.profile_id = v_shadow_id
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
    ELSIF v_shadow_main_player_id IS NOT NULL THEN
      UPDATE public.player_verifications v
         SET is_main = true
       WHERE v.id = (
         SELECT candidate.id
           FROM public.player_verifications candidate
          WHERE candidate.profile_id = p_auth_user_id
            AND candidate.status = 'active'
            AND candidate.player_id = v_shadow_main_player_id
          ORDER BY candidate.verified_at, candidate.created_at, candidate.id
          LIMIT 1
       );
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
        'verificationsMoved', v_moved_verifications,
        'recoveredLegacyHandoff', v_recovered,
        'preservedShadowMainPlayerId', v_shadow_main_player_id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'shadowProfileId', v_shadow_id,
    'verificationsMoved', v_moved_verifications,
    'recoveredLegacyHandoff', v_recovered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_bot_identity(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bot_identity(uuid, text, text, text) TO service_role;

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
  v_actual_role text;
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

  IF p_scope = 'club' THEN
    SELECT c.guild_id INTO v_guild_id
      FROM public.clubs c
     WHERE c.id = p_club_id
       AND c.archived_at IS NULL;
    IF v_guild_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_club');
    END IF;
  END IF;

  -- Protect the stored owner grant, not merely the role named in the request.
  IF p_action = 'revoke' AND v_target_id = p_actor_profile_id
     AND EXISTS (
       SELECT 1
         FROM public.user_roles r
        WHERE r.user_id = p_actor_profile_id
          AND r.scope = p_scope
          AND r.role = 'owner'
          AND r.club_id IS NOT DISTINCT FROM p_club_id
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cannot_revoke_self');
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

  v_allowed := COALESCE(
    public.brawlhub_can_administer_role(
      v_actor_global_role, v_actor_club_role, p_scope, p_role
    ),
    false
  );
  IF v_allowed THEN
    FOREACH v_role IN ARRAY COALESCE(v_existing_roles, ARRAY[]::text[]) LOOP
      v_allowed := v_allowed AND COALESCE(
        public.brawlhub_can_administer_role(
          v_actor_global_role, v_actor_club_role, p_scope, v_role
        ),
        false
      );
      IF NOT v_allowed THEN EXIT; END IF;
    END LOOP;
  END IF;
  IF v_allowed IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  v_actual_role := CASE
    WHEN p_action = 'grant' THEN p_role
    WHEN COALESCE(array_length(v_existing_roles, 1), 0) > 0 THEN v_existing_roles[1]
    ELSE p_role
  END;

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
      'submittedRole', p_role,
      'actualRole', v_actual_role,
      'storedRoles', COALESCE(to_jsonb(v_existing_roles), '[]'::jsonb),
      'clubId', p_club_id
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_manual_role_change(uuid, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_manual_role_change(uuid, text, text, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.claim_bot_identity(uuid, text, text, text) IS
  'Atomically claim a Discord shadow profile, create the target before FK use, recover legacy handoffs, and preserve the selected main account.';
COMMENT ON FUNCTION public.apply_manual_role_change(uuid, text, text, uuid, text, text) IS
  'Deny absent actor permissions, protect stored owner grants, and audit the actual role change.';
