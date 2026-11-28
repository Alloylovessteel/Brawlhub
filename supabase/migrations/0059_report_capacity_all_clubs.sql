-- Correct 0058: page over every active guild club, not only clubs that already
-- have a completed snapshot. Otherwise a run of snapshot-less clubs could end
-- paging early and hide later clubs. Rows without snapshots report NULLs, which
-- the bot renders as Unknown capacity.

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
      JOIN public.sync_runs sr ON sr.id = cs.sync_run_id
     WHERE sr.status = 'completed'
     ORDER BY cs.club_id, cs.captured_at DESC, cs.id DESC
  )
  SELECT sc.id AS club_id, l.member_count, l.captured_at
    FROM scoped_clubs sc
    LEFT JOIN latest l ON l.club_id = sc.id
   ORDER BY sc.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.push_report_capacity(text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_report_capacity(text, integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_report_capacity(text, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.push_report_capacity(text, integer, uuid) IS
  'Return one newest-completed-snapshot capacity row per active guild club, paged by club id; clubs without snapshots return NULLs.';
