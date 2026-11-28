-- Reports show each club's current capacity state from the newest completed
-- sync snapshot, not the historical count of full/not-full transitions. This
-- RPC is guild-scoped, keyset-paged and service-role-only so PostgREST caps
-- cannot silently omit clubs.

CREATE OR REPLACE FUNCTION public.push_report_capacity(
  p_guild_id text,
  p_limit integer DEFAULT 1000,
  p_after_club_id uuid DEFAULT NULL
)
RETURNS TABLE (
  club_id uuid,
  member_count integer,
  captured_at timestamptz
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
       AND (p_after_club_id IS NULL OR c.id > p_after_club_id)
  ),
  latest AS (
    SELECT DISTINCT ON (cs.club_id)
           cs.club_id,
           cs.member_count,
           cs.captured_at
      FROM public.club_snapshots cs
      JOIN scoped_clubs sc ON sc.id = cs.club_id
      JOIN public.sync_runs sr ON sr.id = cs.sync_run_id
     WHERE sr.status = 'completed'
     ORDER BY cs.club_id, cs.captured_at DESC, cs.id DESC
  )
  SELECT l.club_id, l.member_count, l.captured_at
    FROM latest l
   ORDER BY l.club_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.push_report_capacity(text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_report_capacity(text, integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_report_capacity(text, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.push_report_capacity(text, integer, uuid) IS
  'Return the newest completed club snapshot per active club in one guild, paged by club id; no rows for empty guild scope.';
