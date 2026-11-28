-- Open club membership discovery must not be truncated by PostgREST's row cap.
-- This keyset-paged, service-role-only RPC lets sync walk every open membership
-- for the requested guild-owned clubs, including departures beyond page one.

CREATE OR REPLACE FUNCTION public.list_open_club_memberships(
  p_club_ids uuid[],
  p_limit integer DEFAULT 500,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  club_id uuid,
  player_id uuid,
  role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.club_id, m.player_id, m.role
    FROM public.club_memberships m
   WHERE m.valid_to IS NULL
     AND m.club_id = ANY (p_club_ids)
     AND (p_after_id IS NULL OR m.id > p_after_id)
   ORDER BY m.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
$$;

CREATE INDEX IF NOT EXISTS idx_club_memberships_open_club_id
    ON public.club_memberships (club_id, id)
 WHERE valid_to IS NULL;

REVOKE ALL ON FUNCTION public.list_open_club_memberships(uuid[], integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_open_club_memberships(uuid[], integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_open_club_memberships(uuid[], integer, uuid) TO service_role;

COMMENT ON FUNCTION public.list_open_club_memberships(uuid[], integer, uuid) IS
  'Return one keyset page of open memberships for the requested clubs; sync derives the club ids from its guild-scoped club read.';
