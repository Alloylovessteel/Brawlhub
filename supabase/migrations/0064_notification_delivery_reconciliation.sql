-- Durable pre-send state and operator reconciliation for membership notices.
-- Additive only; migrations 0001-0063 are untouched.
--
-- A claim used to remain `pending` while Discord was called. If Discord accepted
-- a message and the result write failed, the lease expired and a later sync
-- could send the same notice again. Claims now move to `sending` before Discord,
-- and `sending` is never reclaimable. Uncertain outcomes are kept for operator
-- review instead of being silently retried or silently forgotten.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_delivery_status_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'uncertain'));

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS delivery_reason text,
  ADD COLUMN IF NOT EXISTS prior_delivery_status text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by text;

COMMENT ON COLUMN public.notifications.delivery_status IS
  'Delivery stage. `sending` is a durable pre-send claim; `uncertain` is terminal for automatic reposting.';
COMMENT ON COLUMN public.notifications.delivery_reason IS
  'Sanitized result reason or operator note; never a Discord token or secret.';
COMMENT ON COLUMN public.notifications.prior_delivery_status IS
  'Previous status when an operator explicitly resolved an uncertain or sending claim.';
COMMENT ON COLUMN public.notifications.resolved_at IS
  'When an operator explicitly resolved this delivery outcome.';
COMMENT ON COLUMN public.notifications.resolved_by IS
  'Operator identity or audit reference for an explicit delivery resolution.';

-- 0061 converted all historical failures to uncertain. Their real outcome is
-- unknowable now, so mark the provenance honestly and never bulk-reset them.
UPDATE public.notifications
   SET delivery_reason = 'legacy-uncertain-unverified'
 WHERE delivery_status = 'uncertain'
   AND delivery_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_sending
    ON public.notifications (claimed_at)
 WHERE delivery_status = 'sending';

CREATE INDEX IF NOT EXISTS idx_notifications_operator_review
    ON public.notifications (delivery_status, id)
 WHERE delivery_status IN ('sending', 'uncertain');

-- A sending claim is neither delivered nor safely retryable. Discovery must
-- exclude it so a lease expiry cannot produce a second Discord message.
CREATE OR REPLACE FUNCTION public.list_oldest_unsent_membership_events(
  p_guild_id text,
  p_club_ids uuid[],
  p_since timestamptz,
  p_limit integer,
  p_after_detected_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
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
  WITH scoped_clubs AS (
    SELECT c.id
      FROM public.clubs c
     WHERE NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NOT NULL
       AND c.guild_id = btrim(p_guild_id)
       AND c.archived_at IS NULL
  )
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
   WHERE e.detected_at >= p_since
     AND (
       EXISTS (SELECT 1 FROM scoped_clubs sc WHERE sc.id = e.to_club_id)
       OR EXISTS (SELECT 1 FROM scoped_clubs sc WHERE sc.id = e.from_club_id)
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.notifications n
        WHERE n.event_id = e.id
          AND n.delivery_status IN ('sending', 'sent', 'uncertain')
     )
     AND (
       p_after_detected_at IS NULL
       OR (p_after_id IS NOT NULL
           AND (e.detected_at, e.id) > (p_after_detected_at, p_after_id))
     )
   ORDER BY e.detected_at ASC, e.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.list_oldest_unsent_membership_events(text, uuid[], timestamptz, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_oldest_unsent_membership_events(text, uuid[], timestamptz, integer, timestamptz, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_oldest_unsent_membership_events(text, uuid[], timestamptz, integer, timestamptz, uuid) TO service_role;

COMMENT ON FUNCTION public.list_oldest_unsent_membership_events(text, uuid[], timestamptz, integer, timestamptz, uuid) IS
  'Return the oldest undelivered guild membership events first in stable keyset pages; sending, sent and uncertain claims are excluded.';

-- Operator visibility for claims that automatic delivery must not touch.
CREATE OR REPLACE FUNCTION public.notification_outcomes_page(
  p_guild_id text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  event_id uuid,
  event_type text,
  channel_id text,
  kind text,
  delivery_status text,
  prior_delivery_status text,
  delivery_reason text,
  delivery_owner uuid,
  claimed_at timestamptz,
  lease_until timestamptz,
  delivered_at timestamptz,
  discord_message_id text,
  detected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.id,
         n.event_id,
         n.event_type,
         n.channel_id,
         n.kind,
         n.delivery_status,
         n.prior_delivery_status,
         n.delivery_reason,
         n.delivery_owner,
         n.claimed_at,
         n.lease_until,
         n.delivered_at,
         n.discord_message_id,
         e.detected_at
    FROM public.notifications n
    LEFT JOIN public.membership_events e ON e.id = n.event_id
   WHERE (p_status IS NULL OR n.delivery_status = p_status)
     AND (p_after_id IS NULL OR n.id > p_after_id)
     AND (
       NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NULL
       OR EXISTS (
         SELECT 1
           FROM public.clubs c
          WHERE c.guild_id = btrim(p_guild_id)
            AND (c.id = e.to_club_id OR c.id = e.from_club_id)
       )
     )
   ORDER BY n.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.notification_outcomes_page(text, text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_outcomes_page(text, text, integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_outcomes_page(text, text, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.notification_outcomes_page(text, text, integer, uuid) IS
  'Return a keyset page of notification outcomes for operator review; service role only.';

-- Explicit, auditable resolution. `retry` is available only to an operator who
-- has proven that Discord rejected the message. Ambiguous outcomes stay
-- uncertain by default and are never auto-reposted.
CREATE OR REPLACE FUNCTION public.resolve_notification_outcome(
  p_claim_id uuid,
  p_resolution text,
  p_message_id text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_actor text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated uuid;
BEGIN
  IF p_resolution = 'sent' THEN
    IF NULLIF(btrim(COALESCE(p_message_id, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Operator confirmation requires a Discord message id' USING ERRCODE = '22023';
    END IF;
    UPDATE public.notifications n
       SET prior_delivery_status = COALESCE(n.prior_delivery_status, n.delivery_status),
           delivery_status = 'sent',
           discord_message_id = btrim(p_message_id),
           delivered_at = now(),
           delivery_owner = NULL,
           claimed_at = NULL,
           lease_until = NULL,
           delivery_reason = p_reason,
           resolved_at = now(),
           resolved_by = NULLIF(btrim(COALESCE(p_actor, '')), '')
     WHERE n.id = p_claim_id
       AND n.delivery_status IN ('sending', 'uncertain')
     RETURNING n.id INTO v_updated;

  ELSIF p_resolution = 'retry' THEN
    UPDATE public.notifications n
       SET prior_delivery_status = COALESCE(n.prior_delivery_status, n.delivery_status),
           delivery_status = 'failed',
           discord_message_id = NULL,
           delivery_owner = NULL,
           claimed_at = NULL,
           lease_until = NULL,
           delivery_reason = COALESCE(p_reason, 'operator verified definitive rejection'),
           resolved_at = now(),
           resolved_by = NULLIF(btrim(COALESCE(p_actor, '')), '')
     WHERE n.id = p_claim_id
       AND n.delivery_status IN ('sending', 'uncertain')
     RETURNING n.id INTO v_updated;

  ELSIF p_resolution = 'reviewed-no-repost' THEN
    UPDATE public.notifications n
       SET prior_delivery_status = COALESCE(n.prior_delivery_status, n.delivery_status),
           delivery_status = 'uncertain',
           delivery_owner = NULL,
           claimed_at = NULL,
           lease_until = NULL,
           delivery_reason = COALESCE(p_reason, 'operator reviewed; no repost'),
           resolved_at = now(),
           resolved_by = NULLIF(btrim(COALESCE(p_actor, '')), '')
     WHERE n.id = p_claim_id
       AND n.delivery_status IN ('sending', 'uncertain')
     RETURNING n.id INTO v_updated;

  ELSE
    RAISE EXCEPTION 'Unknown notification resolution' USING ERRCODE = '22023';
  END IF;

  RETURN v_updated IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_notification_outcome(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_notification_outcome(uuid, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_notification_outcome(uuid, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.resolve_notification_outcome(uuid, text, text, text, text) IS
  'Explicitly resolve a sending or uncertain notification after operator proof; retry requires verified evidence that no message exists.';

NOTIFY pgrst, 'reload schema';
