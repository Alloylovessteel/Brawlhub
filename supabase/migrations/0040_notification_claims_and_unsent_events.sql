-- Exclusive notification claims and bounded unsent-event reads.
--
-- A notification claim used to be insert-or-reuse with no ownership or lease,
-- so two workers could both send the same event. Claims now carry a per-run
-- owner and a short lease; only an expired, aged pending/failed row (or a fresh
-- insert) can be claimed. Sending updates are conditioned on that owner so a
-- takeover cannot be overwritten by the stale worker. Notification discovery
-- also moves into a keyset-paginated RPC with a NOT EXISTS filter on delivered
-- claims, replacing unbounded PostgREST selects that could crowd out old rows.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS delivery_owner uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;

UPDATE public.notifications
   SET claimed_at = delivered_at
 WHERE claimed_at IS NULL
   AND delivered_at IS NOT NULL;

COMMENT ON COLUMN public.notifications.delivery_owner IS
  'Sync-run token that currently owns this notification claim.';
COMMENT ON COLUMN public.notifications.lease_until IS
  'Claim lease expiry; a live lease blocks takeover by another sync run.';

CREATE INDEX IF NOT EXISTS idx_notifications_claim_lease
  ON public.notifications (delivery_status, lease_until)
  WHERE delivery_status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_notifications_delivery_owner
  ON public.notifications (delivery_owner)
  WHERE delivery_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_sent_event
  ON public.notifications (event_id)
  WHERE delivery_status = 'sent';

/**
 * Claim one notification for delivery. Returns its id only when this call
 * inserts the row or takes over an expired, sufficiently old pending/failed
 * row. Sent rows and live leases always return NULL.
 */
CREATE OR REPLACE FUNCTION public.claim_notification(
  p_event_id uuid,
  p_channel_id text,
  p_kind text,
  p_owner uuid,
  p_lease_seconds integer DEFAULT 120
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_lease integer := GREATEST(COALESCE(p_lease_seconds, 120), 1);
  v_claim_id uuid;
  v_status text;
  v_lease_until timestamptz;
  v_claimed_at timestamptz;
  v_created_at timestamptz;
  v_attempt integer;
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'A notification claim owner is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('claim_notification:' || COALESCE(p_event_id::text, '') || ':' ||
             COALESCE(p_channel_id, '') || ':' || COALESCE(p_kind, ''))
  );

  FOR v_attempt IN 1..2 LOOP
    SELECT n.id, n.delivery_status, n.lease_until, n.claimed_at, n.created_at
      INTO v_claim_id, v_status, v_lease_until, v_claimed_at, v_created_at
      FROM public.notifications n
     WHERE n.event_id IS NOT DISTINCT FROM p_event_id
       AND n.channel_id IS NOT DISTINCT FROM p_channel_id
       AND n.kind IS NOT DISTINCT FROM p_kind
     ORDER BY n.created_at ASC, n.id ASC
     LIMIT 1
     FOR UPDATE OF n;

    IF v_claim_id IS NOT NULL THEN
      IF v_status = 'sent' THEN
        RETURN NULL;
      END IF;
      IF v_status NOT IN ('pending', 'failed') THEN
        RETURN NULL;
      END IF;
      IF v_lease_until IS NOT NULL AND v_lease_until > v_now THEN
        RETURN NULL;
      END IF;
      IF COALESCE(v_claimed_at, v_created_at) > v_now - make_interval(secs => v_lease) THEN
        RETURN NULL;
      END IF;

      UPDATE public.notifications n
         SET delivery_status = 'pending',
             delivery_owner = p_owner,
             claimed_at = v_now,
             lease_until = v_now + make_interval(secs => v_lease)
       WHERE n.id = v_claim_id
         AND n.delivery_status IN ('pending', 'failed')
         AND (n.lease_until IS NULL OR n.lease_until <= v_now)
         AND COALESCE(n.claimed_at, n.created_at) <= v_now - make_interval(secs => v_lease)
      RETURNING n.id INTO v_claim_id;
      RETURN v_claim_id;
    END IF;

    INSERT INTO public.notifications (
      event_type,
      event_id,
      channel_id,
      kind,
      delivery_status,
      delivery_owner,
      claimed_at,
      lease_until
    )
    VALUES (
      p_kind,
      p_event_id,
      p_channel_id,
      p_kind,
      'pending',
      p_owner,
      v_now,
      v_now + make_interval(secs => v_lease)
    )
    ON CONFLICT ON CONSTRAINT notifications_dedup_key DO NOTHING
    RETURNING id INTO v_claim_id;

    IF v_claim_id IS NOT NULL THEN
      RETURN v_claim_id;
    END IF;
    v_claim_id := NULL;
  END LOOP;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_notification(uuid, text, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_notification(uuid, text, text, uuid, integer) TO service_role;

COMMENT ON FUNCTION public.claim_notification(uuid, text, text, uuid, integer) IS
  'Atomically insert or take over an expired notification claim for one sync-run owner.';

-- Keyset-paginated view of unsent membership events. Returning flat columns
-- keeps the cursor stable and avoids a PostgREST 1000-row cutoff hiding older
-- events from the notification phase.
CREATE OR REPLACE FUNCTION public.list_unsent_membership_events(
  p_club_ids uuid[],
  p_since timestamptz,
  p_limit integer,
  p_before_detected_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  player_id uuid,
  event_type text,
  from_club_id uuid,
  to_club_id uuid,
  detected_at timestamptz,
  player_tag text,
  player_name text,
  from_club_name text,
  to_club_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id,
         e.player_id,
         e.event_type,
         e.from_club_id,
         e.to_club_id,
         e.detected_at,
         pl.tag,
         pl.name,
         fc.name,
         tc.name
    FROM public.membership_events e
    LEFT JOIN public.players pl ON pl.id = e.player_id
    LEFT JOIN public.clubs fc ON fc.id = e.from_club_id
    LEFT JOIN public.clubs tc ON tc.id = e.to_club_id
   WHERE (e.to_club_id = ANY(p_club_ids) OR e.from_club_id = ANY(p_club_ids))
     AND e.detected_at >= p_since
     AND NOT EXISTS (
       SELECT 1
         FROM public.notifications n
        WHERE n.event_id = e.id
          AND n.delivery_status = 'sent'
     )
     AND (
       p_before_detected_at IS NULL
       OR (p_before_id IS NOT NULL
           AND (e.detected_at, e.id) < (p_before_detected_at, p_before_id))
     )
   ORDER BY e.detected_at DESC, e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.list_unsent_membership_events(uuid[], timestamptz, integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_unsent_membership_events(uuid[], timestamptz, integer, timestamptz, uuid) TO service_role;

CREATE INDEX IF NOT EXISTS idx_membership_events_to_club_detected
  ON public.membership_events (to_club_id, detected_at DESC, id DESC)
  WHERE to_club_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_membership_events_from_club_detected
  ON public.membership_events (from_club_id, detected_at DESC, id DESC)
  WHERE from_club_id IS NOT NULL;

COMMENT ON FUNCTION public.list_unsent_membership_events(uuid[], timestamptz, integer, timestamptz, uuid) IS
  'Return unsent membership events for a guild club set in newest-first keyset pages.';
