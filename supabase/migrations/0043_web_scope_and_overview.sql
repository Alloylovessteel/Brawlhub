-- Web club scoping must be complete and exact. The previous web helpers read
-- membership player ids without pagination, then intersected that partial set
-- with a second capped membership query. These service-role-only RPCs do the
-- distinct keyset read and the overview aggregates inside the database.

CREATE OR REPLACE FUNCTION public.web_scoped_player_ids(
  p_club_ids uuid[],
  p_current_only boolean,
  p_limit integer DEFAULT 1000,
  p_after uuid DEFAULT NULL
)
RETURNS TABLE (player_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT m.player_id
    FROM public.club_memberships m
   WHERE (p_club_ids IS NULL OR m.club_id = ANY (p_club_ids))
     AND (NOT COALESCE(p_current_only, false) OR m.valid_to IS NULL)
     AND m.player_id IS NOT NULL
     AND (p_after IS NULL OR m.player_id > p_after)
   ORDER BY player_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.web_scoped_player_ids(uuid[], boolean, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.web_scoped_player_ids(uuid[], boolean, integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_scoped_player_ids(uuid[], boolean, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.web_scoped_player_ids(uuid[], boolean, integer, uuid) IS
  'Distinct membership player ids for a web club scope, with keyset pagination and optional open-membership-only filtering.';

-- One exact aggregate object for the dashboard overview. NULL club ids are
-- unrestricted; an empty array is an explicit zero scope. Trophy values are
-- summed in SQL rather than over a truncated application-side response.
CREATE OR REPLACE FUNCTION public.web_overview_stats(p_club_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_club_ids uuid[] := p_club_ids;
  v_clubs bigint := 0;
  v_players bigint := 0;
  v_memberships bigint := 0;
  v_trophy_count bigint := 0;
  v_trophy_sum bigint := 0;
  v_trophy_average bigint;
BEGIN
  IF v_club_ids IS NOT NULL AND cardinality(v_club_ids) = 0 THEN
    RETURN jsonb_build_object(
      'clubs', 0,
      'players', 0,
      'memberships', 0,
      'trophy_count', 0,
      'trophy_sum', 0,
      'trophy_average', NULL
    );
  END IF;

  SELECT count(*)
    INTO v_clubs
    FROM public.clubs c
   WHERE c.archived_at IS NULL
     AND (v_club_ids IS NULL OR c.id = ANY (v_club_ids));

  SELECT count(DISTINCT m.player_id), count(*)
    INTO v_players, v_memberships
    FROM public.club_memberships m
   WHERE m.valid_to IS NULL
     AND (v_club_ids IS NULL OR m.club_id = ANY (v_club_ids));

  SELECT count(p.trophies),
         COALESCE(sum(p.trophies), 0),
         CASE WHEN count(p.trophies) > 0 THEN round(avg(p.trophies))::bigint ELSE NULL END
    INTO v_trophy_count, v_trophy_sum, v_trophy_average
    FROM public.players p
   WHERE EXISTS (
     SELECT 1
       FROM public.club_memberships m
      WHERE m.player_id = p.id
        AND m.valid_to IS NULL
        AND (v_club_ids IS NULL OR m.club_id = ANY (v_club_ids))
   );

  RETURN jsonb_build_object(
    'clubs', v_clubs,
    'players', v_players,
    'memberships', v_memberships,
    'trophy_count', v_trophy_count,
    'trophy_sum', v_trophy_sum,
    'trophy_average', v_trophy_average
  );
END;
$$;

REVOKE ALL ON FUNCTION public.web_overview_stats(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.web_overview_stats(uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_overview_stats(uuid[]) TO service_role;

COMMENT ON FUNCTION public.web_overview_stats(uuid[]) IS
  'Exact club, player, membership and trophy aggregates for one web read scope.';
