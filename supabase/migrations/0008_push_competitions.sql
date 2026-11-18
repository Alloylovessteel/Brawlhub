-- Task 8: reliable push-competition lifecycle, baselines and submission history.
--
-- This migration is intentionally additive. It never deletes competition data.
-- Existing rows are validated before constraints are added so a broken legacy
-- dataset fails loudly instead of being silently rewritten.

-- ---------------------------------------------------------------------------
-- Validate existing competition data before tightening the schema
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.competitions
    WHERE starts_at IS NULL OR ends_at IS NULL OR ends_at <= starts_at
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0008: competitions with missing or invalid dates exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.competitions
    WHERE status IS NOT NULL AND status NOT IN ('scheduled', 'ended', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0008: competitions with an unsupported status exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.competition_entries
    WHERE score IS NOT NULL AND score < 0
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0008: competition entries with negative scores exist';
  END IF;

  UPDATE public.competitions SET status = 'scheduled' WHERE status IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Competition lifecycle fields and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE public.competitions
  ALTER COLUMN starts_at SET NOT NULL,
  ALTER COLUMN ends_at SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'scheduled',
  ALTER COLUMN status SET NOT NULL,
  ADD COLUMN IF NOT EXISTS goal integer,
  ADD COLUMN IF NOT EXISTS ended_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;

DO $$
BEGIN
  ALTER TABLE public.competitions
    ADD CONSTRAINT competitions_period_check CHECK (ends_at > starts_at);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.competitions
    ADD CONSTRAINT competitions_status_check
    CHECK (status IN ('scheduled', 'ended', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.competitions
    ADD CONSTRAINT competitions_goal_check CHECK (goal IS NULL OR goal > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.competitions
    ADD CONSTRAINT competitions_ended_fields_check
    CHECK (ended_at IS NULL OR (ended_at IS NOT NULL AND status IN ('ended', 'cancelled')));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Duplicate configurations are rejected even when the club is global (NULL).
CREATE UNIQUE INDEX IF NOT EXISTS competitions_configuration_key
  ON public.competitions (
    lower(btrim(name)),
    COALESCE(club_id, '00000000-0000-0000-0000-000000000000'::uuid),
    starts_at,
    ends_at
  );

CREATE INDEX IF NOT EXISTS idx_competitions_ends_at ON public.competitions (ends_at);
CREATE INDEX IF NOT EXISTS idx_competitions_ended_at ON public.competitions (ended_at);

-- ---------------------------------------------------------------------------
-- Entry baselines and join time
-- ---------------------------------------------------------------------------

ALTER TABLE public.competition_entries
  ADD COLUMN IF NOT EXISTS joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS baseline_trophies integer,
  ADD COLUMN IF NOT EXISTS baseline_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS baseline_snapshot_id uuid REFERENCES public.player_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS baseline_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS baseline_recorded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Existing rows already recorded a submission time; reuse it as their join time
-- rather than inventing a new value.
UPDATE public.competition_entries SET joined_at = submitted_at WHERE joined_at IS NULL;

ALTER TABLE public.competition_entries ALTER COLUMN joined_at SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE public.competition_entries
    ADD CONSTRAINT competition_entries_score_check CHECK (score IS NULL OR score >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.competition_entries
    ADD CONSTRAINT competition_entries_baseline_source_check
    CHECK (baseline_source IN ('none', 'player_snapshot', 'manual_verified'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.competition_entries
    ADD CONSTRAINT competition_entries_baseline_check
    CHECK (
      (baseline_source = 'none' AND baseline_trophies IS NULL)
      OR (baseline_source IN ('player_snapshot', 'manual_verified') AND baseline_trophies IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Composite key lets submission rows prove they belong to the same competition
-- as their entry without a trigger.
DO $$
BEGIN
  ALTER TABLE public.competition_entries
    ADD CONSTRAINT competition_entries_id_competition_key UNIQUE (id, competition_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Verified Discord profile -> Brawl Stars player links
-- ---------------------------------------------------------------------------
-- A profile may own multiple active players. A player may belong to only one
-- active profile. Revoked rows are retained as history for the same pair.

CREATE TABLE IF NOT EXISTS public.player_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT player_verifications_status_values_check CHECK (status IN ('active', 'revoked')),
  method text NOT NULL CHECK (method IN ('manual_staff', 'discord_oauth_tag', 'api_snapshot')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  verified_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_verifications_status_check CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_profile_id IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_verifications_active_pair
  ON public.player_verifications (profile_id, player_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_verifications_active_player
  ON public.player_verifications (player_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_player_verifications_profile_history
  ON public.player_verifications (profile_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_verifications_player_history
  ON public.player_verifications (player_id, verified_at DESC);

DROP TRIGGER IF EXISTS trg_player_verifications_updated_at ON public.player_verifications;
CREATE TRIGGER trg_player_verifications_updated_at
  BEFORE UPDATE ON public.player_verifications FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Append-only submission history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.competition_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES public.competitions(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL,
  trophies integer NOT NULL CHECK (trophies >= 0),
  source text NOT NULL CHECK (source IN ('user', 'api')),
  verification_status text NOT NULL CHECK (verification_status IN ('unverified', 'verified')),
  accepted boolean NOT NULL DEFAULT true,
  verified_snapshot_id uuid REFERENCES public.player_snapshots(id) ON DELETE SET NULL,
  verified_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  rejected_at timestamptz,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competition_submissions_entry_competition_fkey
    FOREIGN KEY (entry_id, competition_id)
    REFERENCES public.competition_entries(id, competition_id) ON DELETE RESTRICT,
  CONSTRAINT competition_submissions_verification_check CHECK (
    (verification_status = 'verified' AND verified_snapshot_id IS NOT NULL)
    OR verification_status = 'unverified'
  ),
  CONSTRAINT competition_submissions_accepted_check CHECK (
    (accepted AND accepted_at IS NOT NULL AND rejected_at IS NULL)
    OR (NOT accepted AND rejected_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_competition_submissions_competition_time
  ON public.competition_submissions (competition_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_competition_submissions_entry_time
  ON public.competition_submissions (entry_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_competition_submissions_accepted
  ON public.competition_submissions (competition_id, accepted) WHERE accepted;

CREATE OR REPLACE FUNCTION public.push_submissions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'competition submissions cannot be deleted';
  END IF;

  IF NEW.trophies IS DISTINCT FROM OLD.trophies
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
     OR NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.submitted_by_profile_id IS DISTINCT FROM OLD.submitted_by_profile_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'core competition submission fields cannot be changed';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_competition_submissions_immutable ON public.competition_submissions;
CREATE TRIGGER trg_competition_submissions_immutable
  BEFORE UPDATE OR DELETE ON public.competition_submissions
  FOR EACH ROW EXECUTE FUNCTION public.push_submissions_immutable();

DROP TRIGGER IF EXISTS trg_competition_submissions_updated_at ON public.competition_submissions;
CREATE TRIGGER trg_competition_submissions_updated_at
  BEFORE UPDATE ON public.competition_submissions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants for the new tables (writes stay service-role only)
-- ---------------------------------------------------------------------------

ALTER TABLE public.player_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competition_submissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.player_verifications FROM anon, authenticated;
REVOKE ALL ON TABLE public.competition_submissions FROM anon, authenticated;
GRANT SELECT ON TABLE public.player_verifications TO authenticated;
GRANT SELECT ON TABLE public.competition_submissions TO authenticated;

DROP POLICY IF EXISTS player_verifications_select_own_or_global_staff ON public.player_verifications;
CREATE POLICY player_verifications_select_own_or_global_staff
  ON public.player_verifications FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.is_global_staff(auth.uid())
  );

DROP POLICY IF EXISTS competition_submissions_select ON public.competition_submissions;
CREATE POLICY competition_submissions_select
  ON public.competition_submissions FOR SELECT TO authenticated
  USING (public.has_competition_access(auth.uid(), competition_id));

-- ---------------------------------------------------------------------------
-- Atomic service-role RPCs for lifecycle writes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.push_can_manage_competition(p_profile_id uuid, p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_profile_id
      AND scope = 'global'
      AND role IN ('owner', 'admin', 'staff')
  ) OR (
    p_club_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_profile_id
        AND scope = 'club'
        AND club_id = p_club_id
        AND role IN ('owner', 'admin', 'staff')
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.push_create_competition(
  p_name text,
  p_description text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_club_id uuid,
  p_goal integer,
  p_created_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(p_name);
  v_id uuid;
BEGIN
  IF v_name IS NULL OR length(v_name) < 1 OR length(v_name) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_name');
  END IF;
  IF p_starts_at IS NULL OR p_ends_at IS NULL OR p_ends_at <= p_starts_at OR p_starts_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_period');
  END IF;
  IF p_goal IS NOT NULL AND p_goal <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_goal');
  END IF;
  IF p_club_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'unknown_club');
  END IF;
  IF NOT public.push_can_manage_competition(p_created_by, p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  INSERT INTO public.competitions (
    name, club_id, starts_at, ends_at, rules, status, goal, created_by
  ) VALUES (
    v_name, p_club_id, p_starts_at, p_ends_at, nullif(btrim(p_description), ''),
    'scheduled', p_goal, p_created_by
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, details
  ) VALUES (
    p_created_by, 'competition.created', 'competition', v_id::text,
    jsonb_build_object(
      'name', v_name,
      'clubId', p_club_id,
      'startsAt', p_starts_at,
      'endsAt', p_ends_at,
      'goal', p_goal
    )
  );

  RETURN jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'duplicate');
END $$;

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
     OR now() >= v_competition.ends_at THEN
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

  -- Baselines must come from completed official-API syncs captured no later
  -- than the competition start. Missing baselines stay NULL.
  SELECT ps.id, ps.trophies, ps.captured_at
    INTO v_snapshot_id, v_baseline_trophies, v_baseline_at
  FROM public.player_snapshots ps
  JOIN public.sync_runs sr ON sr.id = ps.sync_run_id
  WHERE ps.player_id = p_player_id
    AND ps.trophies IS NOT NULL
    AND sr.status = 'completed'
    AND ps.captured_at <= v_competition.starts_at
  ORDER BY ps.captured_at DESC, ps.id DESC
  LIMIT 1;

  INSERT INTO public.competition_entries (
    competition_id, player_id, score, submitted_by, approved, submitted_at,
    joined_at, baseline_trophies, baseline_source, baseline_snapshot_id,
    baseline_captured_at, baseline_recorded_by
  ) VALUES (
    p_competition_id, p_player_id, NULL, p_profile_id, false, now(),
    now(), v_baseline_trophies,
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

CREATE OR REPLACE FUNCTION public.push_submit_result(
  p_competition_id uuid,
  p_profile_id uuid,
  p_player_id uuid,
  p_trophies integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competition public.competitions%ROWTYPE;
  v_entry_id uuid;
  v_submission_id uuid;
  v_submitted_at timestamptz;
BEGIN
  SELECT * INTO v_competition
  FROM public.competitions
  WHERE id = p_competition_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_competition.ended_at IS NOT NULL OR v_competition.status IN ('ended', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ended');
  END IF;
  IF now() < v_competition.starts_at OR now() > v_competition.ends_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'outside_period');
  END IF;
  IF p_trophies IS NULL OR p_trophies < 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_trophies');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.player_verifications
    WHERE profile_id = p_profile_id
      AND player_id = p_player_id
      AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_verified');
  END IF;

  SELECT id INTO v_entry_id
  FROM public.competition_entries
  WHERE competition_id = p_competition_id AND player_id = p_player_id;

  IF v_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_joined');
  END IF;

  INSERT INTO public.competition_submissions (
    competition_id, entry_id, trophies, source, verification_status,
    accepted, submitted_by_profile_id, submitted_at, accepted_at
  ) VALUES (
    p_competition_id, v_entry_id, p_trophies, 'user', 'unverified',
    true, p_profile_id, now(), now()
  )
  RETURNING id, submitted_at INTO v_submission_id, v_submitted_at;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_submission_id,
    'submittedAt', v_submitted_at,
    'trophies', p_trophies,
    'verificationStatus', 'unverified'
  );
END $$;

CREATE OR REPLACE FUNCTION public.push_end_competition(
  p_competition_id uuid,
  p_profile_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competition public.competitions%ROWTYPE;
BEGIN
  SELECT * INTO v_competition
  FROM public.competitions
  WHERE id = p_competition_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_competition.ended_at IS NOT NULL OR v_competition.status = 'ended' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_ended');
  END IF;
  IF NOT public.push_can_manage_competition(p_profile_id, v_competition.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  UPDATE public.competitions
     SET status = 'ended', ended_at = now(), ended_by = p_profile_id
   WHERE id = p_competition_id;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, details
  ) VALUES (
    p_profile_id, 'competition.ended', 'competition', p_competition_id::text,
    jsonb_build_object(
      'name', v_competition.name,
      'endedAt', now(),
      'previousStatus', v_competition.status
    )
  );

  RETURN jsonb_build_object('ok', true, 'id', p_competition_id, 'endedAt', now());
END $$;

-- Only trusted server-side callers may mutate competition state.
REVOKE ALL ON FUNCTION public.push_can_manage_competition(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_create_competition(text, text, timestamptz, timestamptz, uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_join_competition(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_submit_result(uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_end_competition(uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.push_can_manage_competition(uuid, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_create_competition(text, text, timestamptz, timestamptz, uuid, integer, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_join_competition(uuid, uuid, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_submit_result(uuid, uuid, uuid, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_end_competition(uuid, uuid) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.push_can_manage_competition(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_create_competition(text, text, timestamptz, timestamptz, uuid, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_join_competition(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_submit_result(uuid, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_end_competition(uuid, uuid) TO service_role;
