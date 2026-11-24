-- Findings 11-12: preserve accepted submissions during late baseline
-- finalization, and page competition entries through an authoritative RPC.
-- Additive only: it replaces two functions and grants/roles them. No existing
-- migration and no guild_settings column is modified.

-- ---------------------------------------------------------------------------
-- Finding 11: accepted submissions are authoritative once competition starts
-- ---------------------------------------------------------------------------

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
  v_preserved boolean := false;
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
      'preservedExistingSubmissions', false,
      'finalizedAt', v_competition.baseline_finalized_at
    );
  END IF;

  -- Once a result has been accepted, its score and the entry baseline already
  -- in use are part of the competition record. Never rewrite those baselines;
  -- still close finalization so later reads do not retry the same work.
  IF EXISTS (
    SELECT 1 FROM public.competition_submissions
    WHERE competition_id = p_competition_id AND accepted
  ) THEN
    v_preserved := true;
  ELSE
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
  END IF;

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
      'updatedEntries', v_updated,
      'preservedExistingSubmissions', v_preserved
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'finalizedAt', v_now,
    'updatedEntries', v_updated,
    'preservedExistingSubmissions', v_preserved
  );
END $$;

-- ---------------------------------------------------------------------------
-- Finding 12: keyset-paged competition entries with joined player records
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.push_competition_entries(
  p_competition_id uuid,
  p_limit integer DEFAULT 1000,
  p_after_joined_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  competition_id uuid,
  player_id uuid,
  joined_at timestamptz,
  baseline_trophies integer,
  baseline_source text,
  baseline_captured_at timestamptz,
  player jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ce.id,
    ce.competition_id,
    ce.player_id,
    ce.joined_at,
    ce.baseline_trophies,
    ce.baseline_source,
    ce.baseline_captured_at,
    jsonb_build_object(
      'id', p.id,
      'tag', p.tag,
      'name', p.name,
      'trophies', p.trophies,
      'highest_trophies', p.highest_trophies,
      'exp_level', p.exp_level,
      'exp_points', p.exp_points,
      'last_synced_at', p.last_synced_at
    ) AS player
  FROM public.competition_entries ce
  JOIN public.players p ON p.id = ce.player_id
  WHERE ce.competition_id = p_competition_id
    AND (
      p_after_joined_at IS NULL
      OR ce.joined_at > p_after_joined_at
      OR (ce.joined_at = p_after_joined_at AND ce.id > p_after_id)
    )
  ORDER BY ce.joined_at ASC, ce.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

-- ---------------------------------------------------------------------------
-- Trusted caller only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.push_finalize_competition_baselines(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_competition_entries(uuid, integer, timestamptz, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.push_finalize_competition_baselines(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_competition_entries(uuid, integer, timestamptz, uuid) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.push_finalize_competition_baselines(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_competition_entries(uuid, integer, timestamptz, uuid) TO service_role;
