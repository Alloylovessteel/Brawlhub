-- Phase 2 hardening: database-level sync lock and atomic membership transitions.
--
-- The lock is held as a row claim with a TTL. It works across separate Node
-- processes and across the web cron route and Discord bot scheduler, because
-- the claim is evaluated by Postgres rather than by application memory.

CREATE TABLE IF NOT EXISTS public.sync_locks (
  scope text PRIMARY KEY,
  locked_by uuid,
  locked_at timestamptz,
  locked_until timestamptz
);

ALTER TABLE public.sync_locks ENABLE ROW LEVEL SECURITY;

INSERT INTO public.sync_locks (scope)
VALUES ('all-clubs')
ON CONFLICT (scope) DO NOTHING;

-- Returns the token when the lock was acquired, otherwise NULL.
CREATE OR REPLACE FUNCTION public.try_acquire_sync_lock(
  p_scope text,
  p_token uuid,
  p_ttl_seconds integer DEFAULT 1800
)
RETURNS uuid
LANGUAGE sql
AS $$
  UPDATE public.sync_locks
     SET locked_by = p_token,
         locked_at = now(),
         locked_until = now() + make_interval(secs => GREATEST(p_ttl_seconds, 1))
   WHERE scope = p_scope
     AND (locked_by IS NULL OR locked_until IS NULL OR locked_until < now())
  RETURNING locked_by;
$$;

CREATE OR REPLACE FUNCTION public.release_sync_lock(
  p_scope text,
  p_token uuid
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.sync_locks
     SET locked_by = NULL,
         locked_at = NULL,
         locked_until = NULL
   WHERE scope = p_scope
     AND locked_by = p_token;
$$;

-- Applies one membership transition atomically: dedupe the event, close the
-- previous membership and open the new one in a single Postgres transaction.
CREATE OR REPLACE FUNCTION public.apply_membership_transition(
  p_player_id uuid,
  p_event_type text,
  p_from_club_id uuid,
  p_to_club_id uuid,
  p_detected_at timestamptz,
  p_run_id uuid,
  p_role text,
  p_valid_from timestamptz,
  p_close_membership_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id uuid;
BEGIN
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
       AND valid_to IS NULL;
  END IF;

  IF p_to_club_id IS NOT NULL THEN
    INSERT INTO public.club_memberships (club_id, player_id, role, valid_from, valid_to)
    SELECT p_to_club_id, p_player_id, p_role, p_valid_from, NULL
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.club_memberships
      WHERE player_id = p_player_id
        AND club_id = p_to_club_id
        AND valid_to IS NULL
    );
  END IF;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_sync_lock(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_sync_lock(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_membership_transition(uuid, text, uuid, uuid, timestamptz, uuid, text, timestamptz, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.try_acquire_sync_lock(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sync_lock(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_membership_transition(uuid, text, uuid, uuid, timestamptz, uuid, text, timestamptz, uuid) TO service_role;
