-- Findings 16-18: server-side competition counts/standings and authoritative
-- pre-start baseline finalization. This migration is additive: it adds one
-- column and RPCs (plus a replacement join RPC with a safer snapshot cutoff).
-- No existing migration and no guild_settings column is modified.

-- ---------------------------------------------------------------------------
-- Finding 16: entry counts aggregated for the guild-scoped competition ids
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.push_competition_entry_counts(p_competition_ids uuid[])
RETURNS TABLE (competition_id uuid, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ce.competition_id, count(*)::bigint AS count
  FROM public.competition_entries ce
  JOIN (
    SELECT DISTINCT ids.competition_id
    FROM unnest(COALESCE(p_competition_ids, ARRAY[]::uuid[])) AS ids(competition_id)
  ) AS requested
    ON requested.competition_id = ce.competition_id
  GROUP BY ce.competition_id;
$$;

-- ---------------------------------------------------------------------------
-- Finding 17: accepted-only, per-entry standings with post-rank keyset paging
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.push_competition_standings(
  p_competition_id uuid,
  p_limit integer DEFAULT 1000,
  p_after_submitted_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  competition_id uuid,
  entry_id uuid,
  trophies integer,
  source text,
  verification_status text,
  accepted boolean,
  submitted_by_profile_id uuid,
  submitted_at timestamptz,
  verified_snapshot_id uuid,
  verified_by_profile_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      cs.id,
      cs.competition_id,
      cs.entry_id,
      cs.trophies,
      cs.source,
      cs.verification_status,
      cs.accepted,
      cs.submitted_by_profile_id,
      cs.submitted_at,
      cs.verified_snapshot_id,
      cs.verified_by_profile_id,
      row_number() OVER (
        PARTITION BY cs.entry_id
        ORDER BY cs.submitted_at DESC, cs.id DESC
      ) AS rn
    FROM public.competition_submissions cs
    WHERE cs.competition_id = p_competition_id
      AND cs.accepted
  )
  SELECT
    r.id,
    r.competition_id,
    r.entry_id,
    r.trophies,
    r.source,
    r.verification_status,
    r.accepted,
    r.submitted_by_profile_id,
    r.submitted_at,
    r.verified_snapshot_id,
    r.verified_by_profile_id
  FROM ranked r
  WHERE r.rn = 1
    AND (
      p_after_submitted_at IS NULL
      OR r.submitted_at < p_after_submitted_at
      OR (r.submitted_at = p_after_submitted_at AND r.id < p_after_id)
    )
  ORDER BY r.submitted_at DESC, r.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

-- ---------------------------------------------------------------------------
-- Finding 18: authoritative baseline finalization at competition start
-- ---------------------------------------------------------------------------

ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS baseline_finalized_at timestamptz;

CREATE OR REPLACE FUNCTION public.push_finalize_competition_baselines(p_competition_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competition public.competitions%ROWTYPE;
  v_now timestamptz := now();
  v_updated integer := 0;
BEGIN
  SELECT * INTO v_competition
  FROM public.competitions
  WHERE id = p_competition_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_now < v_competition.starts_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_started');
  END IF;
  IF v_competition.baseline_finalized_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'alreadyFinalized', true,
      'finalizedAt', v_competition.baseline_finalized_at
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.competition_submissions
    WHERE competition_id = p_competition_id AND accepted
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'submissions_exist');
  END IF;

  -- A late pre-start snapshot that did not exist at join time is included;
  -- snapshots after starts_at and incomplete sync runs are never used.
  WITH best_snapshot AS (
    SELECT
      ps.player_id,
      ps.id AS snapshot_id,
      ps.trophies,
      ps.captured_at,
      row_number() OVER (
        PARTITION BY ps.player_id
        ORDER BY ps.captured_at DESC, ps.id DESC
      ) AS rn
    FROM public.player_snapshots ps
    JOIN public.sync_runs sr ON sr.id = ps.sync_run_id
    WHERE sr.status = 'completed'
      AND ps.trophies IS NOT NULL
      AND ps.captured_at <= v_competition.starts_at
  )
  UPDATE public.competition_entries ce
     SET baseline_trophies = bs.trophies,
         baseline_source = CASE WHEN bs.snapshot_id IS NULL THEN 'none' ELSE 'player_snapshot' END,
         baseline_snapshot_id = bs.snapshot_id,
         baseline_captured_at = bs.captured_at
    FROM (
      SELECT id, player_id
      FROM public.competition_entries
      WHERE competition_id = p_competition_id
    ) AS target
    LEFT JOIN best_snapshot bs
      ON bs.player_id = target.player_id AND bs.rn = 1
   WHERE ce.id = target.id
     AND ce.baseline_source <> 'manual_verified';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  UPDATE public.competitions
     SET baseline_finalized_at = v_now
   WHERE id = p_competition_id;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, details
  ) VALUES (
    NULL, 'competition.baselines_finalized', 'competition', p_competition_id::text,
    jsonb_build_object(
      'competitionId', p_competition_id,
      'finalizedAt', v_now,
      'updatedEntries', v_updated
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'finalizedAt', v_now,
    'updatedEntries', v_updated
  );
END $$;

-- Join-time baselines should only use snapshots already captured at join time.
-- Finalization at start remains authoritative for late pre-start snapshots.
CREATE OR REPLACE FUNCTION public.push_join_competition(
  p_competition_id uuid,
  p_profile_id uuid,
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competition public.competitions%ROWTYPE;
  v_now timestamptz := now();
  v_snapshot_id uuid;
  v_baseline_trophies integer;
  v_baseline_at timestamptz;
  v_entry_id uuid;
BEGIN
  SELECT * INTO v_competition
  FROM public.competitions
  WHERE id = p_competition_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_competition.ended_at IS NOT NULL
     OR v_competition.status IN ('ended', 'cancelled')
     OR v_now >= v_competition.ends_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ended');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = p_player_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.player_verifications
    WHERE profile_id = p_profile_id
      AND player_id = p_player_id
      AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_verified');
  END IF;
  IF v_competition.club_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.club_memberships
       WHERE player_id = p_player_id
         AND club_id = v_competition.club_id
         AND valid_to IS NULL
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'wrong_club');
  END IF;

  SELECT ps.id, ps.trophies, ps.captured_at
    INTO v_snapshot_id, v_baseline_trophies, v_baseline_at
  FROM public.player_snapshots ps
  JOIN public.sync_runs sr ON sr.id = ps.sync_run_id
  WHERE ps.player_id = p_player_id
    AND ps.trophies IS NOT NULL
    AND sr.status = 'completed'
    AND ps.captured_at <= least(v_now, v_competition.starts_at)
  ORDER BY ps.captured_at DESC, ps.id DESC
  LIMIT 1;

  INSERT INTO public.competition_entries (
    competition_id, player_id, score, submitted_by, approved, submitted_at,
    joined_at, baseline_trophies, baseline_source, baseline_snapshot_id,
    baseline_captured_at, baseline_recorded_by
  ) VALUES (
    p_competition_id, p_player_id, NULL, p_profile_id, false, v_now,
    v_now, v_baseline_trophies,
    CASE WHEN v_snapshot_id IS NULL THEN 'none' ELSE 'player_snapshot' END,
    v_snapshot_id, v_baseline_at, p_profile_id
  )
  ON CONFLICT ON CONSTRAINT competition_entries_unique DO NOTHING
  RETURNING id INTO v_entry_id;

  IF v_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_joined');
  END IF;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, details
  ) VALUES (
    p_profile_id, 'competition.joined', 'competition_entry', v_entry_id::text,
    jsonb_build_object(
      'competitionId', p_competition_id,
      'playerId', p_player_id,
      'baselineTrophies', v_baseline_trophies
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_entry_id,
    'baselineTrophies', v_baseline_trophies,
    'baselineSource', CASE WHEN v_snapshot_id IS NULL THEN 'none' ELSE 'player_snapshot' END,
    'baselineCapturedAt', v_baseline_at
  );
END $$;

-- ---------------------------------------------------------------------------
-- Trusted caller only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.push_competition_entry_counts(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_competition_standings(uuid, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_finalize_competition_baselines(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_join_competition(uuid, uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.push_competition_entry_counts(uuid[]) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_competition_standings(uuid, integer, timestamptz, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_finalize_competition_baselines(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_join_competition(uuid, uuid, uuid) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.push_competition_entry_counts(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_competition_standings(uuid, integer, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_finalize_competition_baselines(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_join_competition(uuid, uuid, uuid) TO service_role;
