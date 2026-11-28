-- Membership notices need a terminal "uncertain" outcome for sends whose
-- result cannot be proven, and an oldest-first discovery read so a busy guild
-- cannot starve older unsent events inside the retention window.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_delivery_status_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sent', 'failed', 'uncertain'));

-- Historical failures may include requests Discord accepted before a timeout.
-- They are no longer safe to auto-repost.
UPDATE public.notifications
   SET delivery_status = 'uncertain'
 WHERE delivery_status = 'failed';

CREATE INDEX IF NOT EXISTS idx_notifications_settled_event
    ON public.notifications (event_id)
 WHERE delivery_status IN ('sent', 'uncertain');

-- Oldest-first keyset pages of unsent guild events. The 7-day retention window
-- is applied by the caller; paging from the oldest row drains backlogs instead
-- of repeatedly selecting only the 20 newest events.
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
          AND n.delivery_status IN ('sent', 'uncertain')
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
  'Return the oldest undelivered guild membership events first in stable keyset pages; sent and uncertain claims are excluded.';
