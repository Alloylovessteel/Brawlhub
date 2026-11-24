-- Guild-scoped open memberships, database-side lock verification and atomic
-- crash recovery.
--
-- 0035 scoped open membership uniqueness to (player, club). Two guilds can
-- register the same real club as separate rows, but the invariant the sync
-- reconciler actually needs is one open membership per (player, guild). Store
-- the guild id on the membership row, keep it derived from the club, and make
-- the membership RPCs re-check both the guild scope and the current sync-lock
-- owner inside Postgres. Recovery becomes one locked RPC so a startup cannot
-- race another worker's read-check-write sequence.

ALTER TABLE public.club_memberships
  ADD COLUMN IF NOT EXISTS guild_id text;

-- Backfill from the owning club before enforcing NOT NULL.
UPDATE public.club_memberships cm
   SET guild_id = c.guild_id
  FROM public.clubs c
 WHERE c.id = cm.club_id
   AND (cm.guild_id IS NULL OR cm.guild_id <> c.guild_id);

ALTER TABLE public.club_memberships ALTER COLUMN guild_id SET NOT NULL;

COMMENT ON COLUMN public.club_memberships.guild_id IS
  'Discord guild that owns the club row; open memberships are unique per player and guild.';

-- Even a direct table write cannot desynchronise the denormalised guild id.
CREATE OR REPLACE FUNCTION public.sync_club_membership_guild_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_guild_id text;
BEGIN
  SELECT c.guild_id INTO v_guild_id
    FROM public.clubs c
   WHERE c.id = NEW.club_id;

  IF v_guild_id IS NULL THEN
    RAISE EXCEPTION 'Club % does not exist', NEW.club_id USING ERRCODE = '23503';
  END IF;
  IF NEW.guild_id IS NOT NULL AND NEW.guild_id <> v_guild_id THEN
    RAISE EXCEPTION 'Membership guild_id does not match club %', NEW.club_id USING ERRCODE = '23514';
  END IF;
  NEW.guild_id := v_guild_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_club_membership_guild_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_club_membership_guild_id() TO service_role;

DROP TRIGGER IF EXISTS trg_club_memberships_guild_id ON public.club_memberships;
CREATE TRIGGER trg_club_memberships_guild_id
  BEFORE INSERT OR UPDATE OF club_id, guild_id ON public.club_memberships
  FOR EACH ROW EXECUTE FUNCTION public.sync_club_membership_guild_id();

-- Preflight: a corrupt deployment with two open rows for one player in the same
-- guild must be repaired by an operator rather than failing index creation with
-- an opaque duplicate-key error.
DO $$
DECLARE
  v_groups integer;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(player_id::text, ', ' ORDER BY player_id)
    INTO v_groups, v_sample
    FROM (
      SELECT cm.player_id
        FROM public.club_memberships cm
       WHERE cm.valid_to IS NULL
       GROUP BY cm.player_id, cm.guild_id
      HAVING count(*) > 1
    ) duplicates;

  IF COALESCE(v_groups, 0) > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce one open membership per player and guild: % duplicate groups found (players: %)',
      v_groups,
      left(COALESCE(v_sample, ''), 500);
  END IF;
END $$;

DROP INDEX IF EXISTS public.uq_club_memberships_open_player_club;
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_memberships_open_player_guild
  ON public.club_memberships (player_id, guild_id)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_club_memberships_guild_player_valid
  ON public.club_memberships (guild_id, player_id, valid_to);

COMMENT ON INDEX public.uq_club_memberships_open_player_guild IS
  'One open membership per player and Discord guild; different guilds track the same player independently.';

-- Read-only ownership check used at sync phase boundaries. It does not extend
-- the TTL; renewal remains the responsibility of the heartbeat.
CREATE OR REPLACE FUNCTION public.assert_sync_lock_ownership(
  p_scope text,
  p_token uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.sync_locks l
     WHERE l.scope = p_scope
       AND l.locked_by = p_token
       AND (l.locked_until IS NULL OR l.locked_until > now())
  );
$$;

REVOKE ALL ON FUNCTION public.assert_sync_lock_ownership(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_sync_lock_ownership(text, uuid) TO service_role;

-- Replace the 0003/0020 membership RPCs with guild-scoped, lock-verifying
-- versions. The extra parameters are optional so old callers remain valid, but
-- the sync worker always supplies them.
DROP FUNCTION IF EXISTS public.apply_membership_transition(uuid, text, uuid, uuid, timestamptz, uuid, text, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.apply_club_role_change(uuid, uuid, uuid, text, text, timestamptz, uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.apply_membership_transition(
  p_player_id uuid,
  p_event_type text,
  p_from_club_id uuid,
  p_to_club_id uuid,
  p_detected_at timestamptz,
  p_run_id uuid,
  p_role text,
  p_valid_from timestamptz,
  p_close_membership_id uuid,
  p_guild_id text DEFAULT NULL,
  p_lock_scope text DEFAULT NULL,
  p_lock_token uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
  v_guild_id text;
  v_club_guild text;
BEGIN
  IF p_lock_token IS NOT NULL
     AND (p_lock_scope IS NULL OR btrim(p_lock_scope) = ''
          OR NOT public.assert_sync_lock_ownership(p_lock_scope, p_lock_token)) THEN
    RAISE EXCEPTION 'Sync lock lost; refusing membership transition' USING ERRCODE = 'P0001';
  END IF;

  v_guild_id := NULLIF(btrim(COALESCE(p_guild_id, '')), '');
  IF v_guild_id IS NULL THEN
    SELECT c.guild_id INTO v_guild_id
      FROM public.clubs c
     WHERE c.id = COALESCE(p_to_club_id, p_from_club_id);
  END IF;
  IF v_guild_id IS NULL AND p_close_membership_id IS NOT NULL THEN
    SELECT cm.guild_id INTO v_guild_id
      FROM public.club_memberships cm
     WHERE cm.id = p_close_membership_id;
  END IF;
  IF v_guild_id IS NULL THEN
    RAISE EXCEPTION 'Guild scope is required for a membership transition' USING ERRCODE = '22023';
  END IF;

  IF p_from_club_id IS NOT NULL THEN
    SELECT c.guild_id INTO v_club_guild FROM public.clubs c WHERE c.id = p_from_club_id;
    IF v_club_guild IS NULL OR v_club_guild <> v_guild_id THEN
      RAISE EXCEPTION 'Source club is outside the guild sync scope' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_to_club_id IS NOT NULL THEN
    SELECT c.guild_id INTO v_club_guild FROM public.clubs c WHERE c.id = p_to_club_id;
    IF v_club_guild IS NULL OR v_club_guild <> v_guild_id THEN
      RAISE EXCEPTION 'Destination club is outside the guild sync scope' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_close_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.club_memberships cm
     WHERE cm.id = p_close_membership_id
       AND cm.guild_id = v_guild_id
       AND cm.valid_to IS NULL
       AND (p_from_club_id IS NULL OR cm.club_id = p_from_club_id)
  ) THEN
    RAISE EXCEPTION 'Membership row is outside the guild sync scope' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.membership_events (
    player_id,
    event_type,
    from_club_id,
    to_club_id,
    source_sync_run_id,
    detected_at
  )
  VALUES (
    p_player_id,
    p_event_type,
    p_from_club_id,
    p_to_club_id,
    p_run_id,
    p_detected_at
  )
  ON CONFLICT ON CONSTRAINT membership_events_dedup_key
  DO UPDATE SET
    detected_at = EXCLUDED.detected_at,
    updated_at = now()
  RETURNING id INTO v_event_id;

  IF p_close_membership_id IS NOT NULL THEN
    UPDATE public.club_memberships
       SET valid_to = p_valid_from,
           updated_at = now()
     WHERE id = p_close_membership_id
       AND guild_id = v_guild_id
       AND valid_to IS NULL;
  END IF;

  IF p_to_club_id IS NOT NULL THEN
    INSERT INTO public.club_memberships (club_id, player_id, guild_id, role, valid_from, valid_to)
    SELECT p_to_club_id, p_player_id, v_guild_id, p_role, p_valid_from, NULL
    WHERE NOT EXISTS (
      SELECT 1
        FROM public.club_memberships
       WHERE player_id = p_player_id
         AND guild_id = v_guild_id
         AND valid_to IS NULL
    );
  END IF;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_membership_transition(uuid, text, uuid, uuid, timestamptz, uuid, text, timestamptz, uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_membership_transition(uuid, text, uuid, uuid, timestamptz, uuid, text, timestamptz, uuid, text, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_club_role_change(
  p_club_id uuid,
  p_player_id uuid,
  p_membership_id uuid,
  p_from_role text,
  p_to_role text,
  p_detected_at timestamptz,
  p_run_id uuid,
  p_valid_from timestamptz,
  p_guild_id text DEFAULT NULL,
  p_lock_scope text DEFAULT NULL,
  p_lock_token uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_change_id uuid;
  v_guild_id text;
  v_club_guild text;
BEGIN
  IF p_lock_token IS NOT NULL
     AND (p_lock_scope IS NULL OR btrim(p_lock_scope) = ''
          OR NOT public.assert_sync_lock_ownership(p_lock_scope, p_lock_token)) THEN
    RAISE EXCEPTION 'Sync lock lost; refusing club role change' USING ERRCODE = 'P0001';
  END IF;

  SELECT c.guild_id INTO v_club_guild FROM public.clubs c WHERE c.id = p_club_id;
  IF v_club_guild IS NULL THEN
    RAISE EXCEPTION 'Club % does not exist', p_club_id USING ERRCODE = '23503';
  END IF;
  v_guild_id := NULLIF(btrim(COALESCE(p_guild_id, '')), '');
  IF v_guild_id IS NULL THEN
    v_guild_id := v_club_guild;
  ELSIF v_guild_id <> v_club_guild THEN
    RAISE EXCEPTION 'Club is outside the guild sync scope' USING ERRCODE = '22023';
  END IF;

  UPDATE public.club_memberships
     SET valid_to = p_valid_from,
         updated_at = now()
   WHERE id = p_membership_id
     AND club_id = p_club_id
     AND player_id = p_player_id
     AND guild_id = v_guild_id
     AND valid_to IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.club_role_changes (
    club_id,
    player_id,
    from_role,
    to_role,
    source_sync_run_id,
    detected_at
  )
  VALUES (
    p_club_id,
    p_player_id,
    p_from_role,
    p_to_role,
    p_run_id,
    p_detected_at
  )
  ON CONFLICT ON CONSTRAINT club_role_changes_dedup_key
  DO UPDATE SET detected_at = EXCLUDED.detected_at
  RETURNING id INTO v_change_id;

  INSERT INTO public.club_memberships (club_id, player_id, guild_id, role, valid_from, valid_to)
  SELECT p_club_id, p_player_id, v_guild_id, p_to_role, p_valid_from, NULL
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.club_memberships
     WHERE player_id = p_player_id
       AND guild_id = v_guild_id
       AND valid_to IS NULL
  );

  RETURN v_change_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_club_role_change(uuid, uuid, uuid, text, text, timestamptz, uuid, timestamptz, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_club_role_change(uuid, uuid, uuid, text, text, timestamptz, uuid, timestamptz, text, text, uuid) TO service_role;

/**
 * Atomically fail interrupted runs and clear only locks that still represent
 * the interrupted state observed inside this transaction. The advisory lock
 * serialises concurrent startups; conditional updates re-check every predicate
 * that justified the recovery decision.
 */
CREATE OR REPLACE FUNCTION public.recover_interrupted_syncs(
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  v_reason text := 'Sync interrupted by process restart';
  v_run record;
  v_lock record;
  v_had_lock boolean;
  v_recovered integer := 0;
  v_cleared text[] := ARRAY[]::text[];
  v_scope text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('recover_interrupted_syncs'));

  FOR v_run IN
    SELECT r.id, r.scope
      FROM public.sync_runs r
     WHERE r.status = 'running'
       AND r.finished_at IS NULL
     ORDER BY r.started_at ASC NULLS FIRST, r.id ASC
     FOR UPDATE OF r
  LOOP
    v_scope := NULLIF(btrim(COALESCE(v_run.scope, '')), '');
    v_had_lock := false;
    SELECT l.scope, l.locked_by, l.locked_at, l.locked_until
      INTO v_lock
      FROM public.sync_locks l
     WHERE l.scope IS NOT DISTINCT FROM v_scope
     FOR UPDATE OF l;
    IF FOUND THEN
      v_had_lock := true;
    END IF;

    -- A live owner (or an open-ended legacy claim) means the process is still
    -- working; only absent or expired claims are recoverable.
    IF v_had_lock AND v_lock.locked_by IS NOT NULL
       AND (v_lock.locked_until IS NULL OR v_lock.locked_until >= v_now) THEN
      CONTINUE;
    END IF;

    UPDATE public.sync_runs r
       SET status = 'failed',
           error = v_reason,
           last_error = v_reason,
           finished_at = v_now
     WHERE r.id = v_run.id
       AND r.status = 'running'
       AND r.finished_at IS NULL;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_recovered := v_recovered + 1;

    IF v_had_lock AND v_scope IS NOT NULL THEN
      UPDATE public.sync_locks l
         SET locked_by = NULL,
             locked_at = NULL,
             locked_until = NULL
       WHERE l.scope = v_scope
         AND l.locked_by IS NOT DISTINCT FROM v_lock.locked_by
         AND l.locked_at IS NOT DISTINCT FROM v_lock.locked_at
         AND l.locked_until IS NOT DISTINCT FROM v_lock.locked_until
         AND (l.locked_until IS NULL OR l.locked_until < v_now)
         AND NOT EXISTS (
           SELECT 1
             FROM public.sync_runs other
            WHERE other.scope = v_scope
              AND other.status = 'running'
              AND other.finished_at IS NULL
         );
      IF FOUND THEN
        v_cleared := array_append(v_cleared, v_scope);
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'recoveredRuns', v_recovered,
    'clearedScopes', to_jsonb(v_cleared)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_interrupted_syncs(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_interrupted_syncs(timestamptz) TO service_role;

COMMENT ON FUNCTION public.recover_interrupted_syncs(timestamptz) IS
  'Atomically fail interrupted running rows and clear only matching expired sync-lock claims.';
