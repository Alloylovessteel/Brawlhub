-- One-time recovery for legacy pre-0038 OAuth shadow handoffs.
--
-- Prior migrations are not edited here because their checksums are already
-- recorded by Supabase; every change below is additive.

-- ---------------------------------------------------------------------------
-- Legacy shadow-name parser
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.legacy_shadow_target_profile_id(
  p_discord_user_id text
)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_discord_user_id ~ '^shadow:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(:retry)*$'
      THEN substring(p_discord_user_id FROM 8 FOR 36)::uuid
    ELSE NULL::uuid
  END;
$$;

REVOKE ALL ON FUNCTION public.legacy_shadow_target_profile_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.legacy_shadow_target_profile_id(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.legacy_shadow_target_profile_id(text) TO service_role;

COMMENT ON FUNCTION public.legacy_shadow_target_profile_id(text) IS
  'Parse an anchored shadow:<oauth profile uuid>[:retry...] profile name into its target profile id, or NULL.';

-- ---------------------------------------------------------------------------
-- One-time recovery RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.recover_legacy_oauth_shadow_handoff(
  p_shadow_profile_id uuid,
  p_target_profile_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shadow_id uuid;
  v_target_id uuid;
  v_real_discord_id text;
  v_target_discord_id text;
  v_shadow_discord_id text;
  v_parsed_target_id uuid;
  v_shadow_replaced_by uuid;
  v_shadow_replaced_at timestamptz;
  v_directory_profile_id uuid;
  v_target_main_id uuid;
  v_shadow_main_player_id uuid;
  v_other_shadow_count bigint;
  v_revoked_ids uuid[] := ARRAY[]::uuid[];
  v_moved_ids uuid[] := ARRAY[]::uuid[];
  v_recovered_at timestamptz;
BEGIN
  IF p_shadow_profile_id IS NULL
     OR p_target_profile_id IS NULL
     OR p_shadow_profile_id = p_target_profile_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_legacy_pair');
  END IF;

  -- The advisory key must come from the real Discord id before any row lock,
  -- matching the key used by claim_bot_identity.
  SELECT p.discord_user_id
    INTO v_real_discord_id
    FROM public.profiles p
   WHERE p.id = p_target_profile_id;

  IF v_real_discord_id IS NULL
     OR v_real_discord_id !~ '^[0-9]{17,20}$'
     OR public.legacy_shadow_target_profile_id(v_real_discord_id) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_target_discord_id');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claim_bot_identity:' || v_real_discord_id));

  -- Re-read under locks; a concurrent claim can have changed either profile
  -- while this transaction waited for the advisory lock.
  SELECT p.id, p.discord_user_id, p.replaced_by_profile_id, p.replaced_at
    INTO v_shadow_id, v_shadow_discord_id, v_shadow_replaced_by, v_shadow_replaced_at
    FROM public.profiles p
   WHERE p.id = p_shadow_profile_id
   FOR UPDATE OF p;

  SELECT p.id, p.discord_user_id
    INTO v_target_id, v_target_discord_id
    FROM public.profiles p
   WHERE p.id = p_target_profile_id
   FOR UPDATE OF p;

  v_parsed_target_id := public.legacy_shadow_target_profile_id(v_shadow_discord_id);

  IF v_shadow_id IS NULL
     OR v_target_id IS NULL
     OR v_parsed_target_id IS NULL
     OR v_parsed_target_id <> p_target_profile_id
     OR (v_shadow_replaced_by IS NOT NULL AND v_shadow_replaced_by <> p_target_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_legacy_pair');
  END IF;

  IF v_target_discord_id IS NULL
     OR v_target_discord_id !~ '^[0-9]{17,20}$'
     OR public.legacy_shadow_target_profile_id(v_target_discord_id) IS NOT NULL
     OR v_target_discord_id IS DISTINCT FROM v_real_discord_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_target_discord_id');
  END IF;

  SELECT du.profile_id
    INTO v_directory_profile_id
    FROM public.discord_users du
   WHERE du.discord_user_id = v_real_discord_id;

  IF v_directory_profile_id IS DISTINCT FROM p_target_profile_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_directory_evidence');
  END IF;

  -- A completed earlier pass needs no second audit row or verification move.
  IF v_shadow_replaced_by IS NOT DISTINCT FROM p_target_profile_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.player_verifications pv
        WHERE pv.profile_id = p_shadow_profile_id
          AND pv.status = 'active'
     ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'already_recovered',
      'alreadyRecovered', true,
      'shadowProfileId', p_shadow_profile_id,
      'targetProfileId', p_target_profile_id,
      'discordUserId', v_real_discord_id,
      'movedVerificationIds', to_jsonb(ARRAY[]::uuid[]),
      'revokedVerificationIds', to_jsonb(ARRAY[]::uuid[]),
      'preservedShadowMainPlayerId', NULL,
      'recoveredAt', v_shadow_replaced_at
    );
  END IF;

  -- The legacy handoff left either stranded verifications on the shadow or
  -- still-live role assignments under the shadow profile id.
  IF NOT EXISTS (
       SELECT 1
         FROM public.player_verifications pv
        WHERE pv.profile_id = p_shadow_profile_id
          AND pv.status = 'active'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.guild_role_assignments gra
        WHERE gra.discord_user_id = v_real_discord_id
          AND gra.profile_id = p_shadow_profile_id
          AND gra.revoked_at IS NULL
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_directory_evidence');
  END IF;

  SELECT count(*)
    INTO v_other_shadow_count
    FROM public.profiles p
   WHERE p.id <> p_shadow_profile_id
     AND public.legacy_shadow_target_profile_id(p.discord_user_id) = p_target_profile_id;

  IF v_other_shadow_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ambiguous_shadow');
  END IF;

  v_recovered_at := now();

  SELECT pv.id
    INTO v_target_main_id
    FROM public.player_verifications pv
   WHERE pv.profile_id = p_target_profile_id
     AND pv.status = 'active'
     AND pv.is_main
   ORDER BY pv.verified_at, pv.created_at, pv.id
   LIMIT 1;

  -- Remember which account the shadow had selected before the move. It is the
  -- default replacement when the target has no main of its own.
  SELECT pv.player_id
    INTO v_shadow_main_player_id
    FROM public.player_verifications pv
   WHERE pv.profile_id = p_shadow_profile_id
     AND pv.status = 'active'
     AND pv.is_main
   ORDER BY pv.verified_at, pv.created_at, pv.id
   LIMIT 1;

  -- A player already actively owned by the target or by any other profile is
  -- never moved. Revoking the shadow row keeps the unique active-player index
  -- intact and leaves the unrelated owner untouched.
  WITH revoked AS (
    UPDATE public.player_verifications pv
       SET status = 'revoked',
           revoked_at = now(),
           revoked_by_profile_id = p_target_profile_id,
           is_main = false
     WHERE pv.profile_id = p_shadow_profile_id
       AND pv.status = 'active'
       AND EXISTS (
         SELECT 1
           FROM public.player_verifications other
          WHERE other.player_id = pv.player_id
            AND other.status = 'active'
            AND other.profile_id <> p_shadow_profile_id
       )
    RETURNING pv.id
  )
  SELECT COALESCE(array_agg(revoked.id ORDER BY revoked.id), ARRAY[]::uuid[])
    INTO v_revoked_ids
    FROM revoked;

  UPDATE public.player_verifications pv
     SET is_main = false
   WHERE pv.profile_id = p_target_profile_id
     AND pv.status = 'active'
     AND pv.is_main;

  WITH moved AS (
    UPDATE public.player_verifications pv
       SET profile_id = p_target_profile_id,
           is_main = false,
           verified_by_profile_id = COALESCE(pv.verified_by_profile_id, p_target_profile_id)
     WHERE pv.profile_id = p_shadow_profile_id
       AND pv.status = 'active'
    RETURNING pv.id
  )
  SELECT COALESCE(array_agg(moved.id ORDER BY moved.id), ARRAY[]::uuid[])
    INTO v_moved_ids
    FROM moved;

  IF v_target_main_id IS NOT NULL THEN
    UPDATE public.player_verifications pv
       SET is_main = true
     WHERE pv.id = v_target_main_id
       AND pv.profile_id = p_target_profile_id
       AND pv.status = 'active';
  ELSIF v_shadow_main_player_id IS NOT NULL THEN
    UPDATE public.player_verifications pv
       SET is_main = true
     WHERE pv.id = (
       SELECT candidate.id
         FROM public.player_verifications candidate
        WHERE candidate.profile_id = p_target_profile_id
          AND candidate.status = 'active'
          AND candidate.player_id = v_shadow_main_player_id
        ORDER BY candidate.verified_at, candidate.created_at, candidate.id
        LIMIT 1
     );
  ELSE
    UPDATE public.player_verifications pv
       SET is_main = true
      FROM (
        SELECT candidate.id
          FROM public.player_verifications candidate
         WHERE candidate.profile_id = p_target_profile_id
           AND candidate.status = 'active'
         ORDER BY candidate.verified_at, candidate.created_at, candidate.id
         LIMIT 1
      ) chosen
     WHERE pv.id = chosen.id;
  END IF;

  -- Link the retired identity without deleting it or rewriting history.
  UPDATE public.profiles p
     SET replaced_by_profile_id = COALESCE(p.replaced_by_profile_id, p_target_profile_id),
         replaced_at = COALESCE(p.replaced_at, now())
   WHERE p.id = p_shadow_profile_id;

  UPDATE public.discord_users du
     SET previous_profile_id = p_shadow_profile_id
   WHERE du.discord_user_id = v_real_discord_id
     AND du.profile_id = p_target_profile_id
     AND du.previous_profile_id IS NULL;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, guild_id, details
  ) VALUES (
    NULL,
    'identity.legacy_shadow_recovered',
    'profile',
    p_shadow_profile_id::text,
    NULL,
    jsonb_build_object(
      'discordUserId', v_real_discord_id,
      'targetProfileId', p_target_profile_id,
      'shadowProfileId', p_shadow_profile_id,
      'legacyShadowDiscordId', v_shadow_discord_id,
      'matchedBy', 'legacy_shadow_name',
      'movedVerificationIds', to_jsonb(v_moved_ids),
      'revokedVerificationIds', to_jsonb(v_revoked_ids),
      'preservedShadowMainPlayerId', v_shadow_main_player_id,
      'recoveredAt', v_recovered_at
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'recovered',
    'shadowProfileId', p_shadow_profile_id,
    'targetProfileId', p_target_profile_id,
    'discordUserId', v_real_discord_id,
    'legacyShadowDiscordId', v_shadow_discord_id,
    'movedVerificationIds', to_jsonb(v_moved_ids),
    'revokedVerificationIds', to_jsonb(v_revoked_ids),
    'preservedShadowMainPlayerId', v_shadow_main_player_id,
    'recoveredAt', v_recovered_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_legacy_oauth_shadow_handoff(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_legacy_oauth_shadow_handoff(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_legacy_oauth_shadow_handoff(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.recover_legacy_oauth_shadow_handoff(uuid, uuid) IS
  'Recover a legacy pre-0038 OAuth handoff by moving stranded verifications to the target and linking, but not deleting, the shadow profile.';

-- ---------------------------------------------------------------------------
-- Deterministic one-time backfill
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_candidate record;
  v_result jsonb;
BEGIN
  FOR v_candidate IN
    WITH shadows AS (
      SELECT p.id AS shadow_profile_id,
             public.legacy_shadow_target_profile_id(p.discord_user_id) AS target_profile_id
        FROM public.profiles p
    )
    SELECT shadow_profile_id, target_profile_id
      FROM shadows
     WHERE target_profile_id IS NOT NULL
     ORDER BY target_profile_id, shadow_profile_id
  LOOP
    v_result := public.recover_legacy_oauth_shadow_handoff(
      v_candidate.shadow_profile_id,
      v_candidate.target_profile_id
    );
    RAISE NOTICE 'legacy OAuth shadow recovery % -> %: %',
      v_candidate.shadow_profile_id, v_candidate.target_profile_id, v_result;
  END LOOP;
END $$;
