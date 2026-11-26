-- Rescan finding 7: player eligibility and snapshot history must be filtered
-- and paged inside PostgreSQL. Application-side membership sets and unbounded
-- snapshot reads can be truncated by PostgREST's default row cap, which makes
-- later matches or older history silently disappear.

CREATE INDEX IF NOT EXISTS idx_club_memberships_club_player_valid
  ON public.club_memberships (club_id, player_id, valid_to);

CREATE INDEX IF NOT EXISTS idx_player_snapshots_player_captured_id
  ON public.player_snapshots (player_id, captured_at DESC, id DESC);

-- Guild/bot autocomplete search. Callers must supply an explicit non-null club
-- array; NULL and empty arrays are both empty scopes. The row cap is applied
-- after search and scope filtering, with a stable name/id keyset.
CREATE OR REPLACE FUNCTION public.player_search_scoped(
  p_club_ids uuid[],
  p_search text,
  p_after_name text DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25
)
RETURNS TABLE (player jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT DISTINCT m.player_id
      FROM public.club_memberships m
     WHERE COALESCE(array_length(p_club_ids, 1), 0) > 0
       AND m.club_id = ANY (p_club_ids)
       AND m.player_id IS NOT NULL
  ),
  pattern AS (
    SELECT CASE
      WHEN NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL THEN NULL
      ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    END AS value
  )
  SELECT to_jsonb(p) AS player
    FROM scoped s
    JOIN public.players p ON p.id = s.player_id
   CROSS JOIN pattern q
   WHERE (q.value IS NULL
          OR p.tag ILIKE q.value ESCAPE '\'
          OR p.name ILIKE q.value ESCAPE '\')
     AND (
       p_after_name IS NULL
       OR p.name > p_after_name
       OR (p.name = p_after_name AND p_after_id IS NOT NULL AND p.id > p_after_id)
     )
   ORDER BY p.name ASC, p.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 25);
$$;

REVOKE ALL ON FUNCTION public.player_search_scoped(uuid[], text, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_search_scoped(uuid[], text, text, uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_search_scoped(uuid[], text, text, uuid, integer) TO service_role;

COMMENT ON FUNCTION public.player_search_scoped(uuid[], text, text, uuid, integer) IS
  'Search guild-scoped stored players in SQL with an escaped ILIKE filter, a name/id keyset and a small bounded page.';

-- Exact stored-player lookup with the same guild visibility rule as search.
-- This avoids reading every membership id just to answer one exact tag query.
CREATE OR REPLACE FUNCTION public.player_lookup_scoped_by_tag(
  p_club_ids uuid[],
  p_tag text
)
RETURNS TABLE (player jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(p) AS player
    FROM public.players p
   WHERE COALESCE(array_length(p_club_ids, 1), 0) > 0
     AND p.tag = upper(regexp_replace(btrim(COALESCE(p_tag, '')), '^#+', ''))
     AND EXISTS (
       SELECT 1
         FROM public.club_memberships m
        WHERE m.player_id = p.id
          AND m.club_id = ANY (p_club_ids)
     )
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.player_lookup_scoped_by_tag(uuid[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_lookup_scoped_by_tag(uuid[], text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_lookup_scoped_by_tag(uuid[], text) TO service_role;

COMMENT ON FUNCTION public.player_lookup_scoped_by_tag(uuid[], text) IS
  'Return one stored player only when its exact tag belongs to the supplied guild club scope.';

-- Bounded snapshot pages. A single player id, an explicit player-id array and
-- a club scope are combined with AND when supplied, so an exact player lookup
-- still honours guild isolation. NULL and empty scopes return zero rows. Both
-- sort directions share a stable (captured_at, id) keyset so paging never
-- duplicates or loses tied rows.
CREATE OR REPLACE FUNCTION public.player_snapshot_page(
  p_player_id uuid DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_completed_only boolean DEFAULT false,
  p_newest_first boolean DEFAULT false,
  p_limit integer DEFAULT 1000,
  p_after_captured_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_player_ids uuid[] DEFAULT NULL,
  p_club_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  player_id uuid,
  sync_run_id uuid,
  captured_at timestamptz,
  trophies integer,
  payload_hash text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ps.id, ps.player_id, ps.sync_run_id, ps.captured_at, ps.trophies, ps.payload_hash
    FROM public.player_snapshots ps
   WHERE (p_since IS NULL OR ps.captured_at >= p_since)
     AND (
       NOT COALESCE(p_completed_only, false)
       OR EXISTS (
         SELECT 1
           FROM public.sync_runs sr
          WHERE sr.id = ps.sync_run_id
            AND sr.status = 'completed'
       )
     )
     AND (p_player_id IS NULL OR ps.player_id = p_player_id)
     AND (p_player_ids IS NULL OR ps.player_id = ANY (p_player_ids))
     AND (
       p_club_ids IS NULL
       OR (
         COALESCE(array_length(p_club_ids, 1), 0) > 0
         AND EXISTS (
           SELECT 1
             FROM public.club_memberships m
            WHERE m.player_id = ps.player_id
              AND m.club_id = ANY (p_club_ids)
         )
       )
     )
     AND (
       p_player_id IS NOT NULL
       OR COALESCE(array_length(p_player_ids, 1), 0) > 0
       OR COALESCE(array_length(p_club_ids, 1), 0) > 0
     )
     AND (
       p_after_captured_at IS NULL
       OR (
         COALESCE(p_newest_first, false)
         AND p_after_id IS NOT NULL
         AND (
           ps.captured_at < p_after_captured_at
           OR (ps.captured_at = p_after_captured_at AND ps.id < p_after_id)
         )
       )
       OR (
         NOT COALESCE(p_newest_first, false)
         AND p_after_id IS NOT NULL
         AND (
           ps.captured_at > p_after_captured_at
           OR (ps.captured_at = p_after_captured_at AND ps.id > p_after_id)
         )
       )
     )
   ORDER BY
     CASE WHEN COALESCE(p_newest_first, false) THEN ps.captured_at END DESC,
     CASE WHEN COALESCE(p_newest_first, false) THEN ps.id END DESC,
     CASE WHEN NOT COALESCE(p_newest_first, false) THEN ps.captured_at END ASC,
     CASE WHEN NOT COALESCE(p_newest_first, false) THEN ps.id END ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.player_snapshot_page(uuid, timestamptz, boolean, boolean, integer, timestamptz, uuid, uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_snapshot_page(uuid, timestamptz, boolean, boolean, integer, timestamptz, uuid, uuid[], uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_snapshot_page(uuid, timestamptz, boolean, boolean, integer, timestamptz, uuid, uuid[], uuid[]) TO service_role;

COMMENT ON FUNCTION public.player_snapshot_page(uuid, timestamptz, boolean, boolean, integer, timestamptz, uuid, uuid[], uuid[]) IS
  'Return a bounded, keyset-paged player snapshot history filtered in SQL by scope, date and completed-run status.';
