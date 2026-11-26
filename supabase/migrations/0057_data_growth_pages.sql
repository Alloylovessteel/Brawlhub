-- Rescan findings 13-17: guild-scoped eligibility, snapshot history and
-- delivery discovery must be filtered and paged inside PostgreSQL. PostgREST's
-- max_rows cap cannot be raised by an application-side .limit(), so every new
-- reader below is a service-role-only, keyset-paged RPC with a fail-closed
-- scope. NULL and empty club/guild scopes always return zero rows.

CREATE INDEX IF NOT EXISTS idx_club_snapshots_club_captured_id
  ON public.club_snapshots (club_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_player_verifications_active_player_verified
  ON public.player_verifications (player_id, verified_at DESC, id DESC)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Findings 13 and 15: club snapshots and player snapshots by explicit club
-- scope. Both keep the (captured_at, id) keyset so tied timestamps are never
-- duplicated or lost across pages.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.club_snapshot_page(
  p_club_ids uuid[],
  p_since timestamptz DEFAULT NULL,
  p_completed_only boolean DEFAULT true,
  p_newest_first boolean DEFAULT true,
  p_limit integer DEFAULT 1000,
  p_after_captured_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  club_id uuid,
  id uuid,
  sync_run_id uuid,
  captured_at timestamptz,
  trophies integer,
  member_count integer,
  raw jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cs.club_id, cs.id, cs.sync_run_id, cs.captured_at, cs.trophies, cs.member_count, cs.raw
    FROM public.club_snapshots cs
   WHERE COALESCE(array_length(p_club_ids, 1), 0) > 0
     AND cs.club_id = ANY (p_club_ids)
     AND (p_since IS NULL OR cs.captured_at >= p_since)
     AND (
       NOT COALESCE(p_completed_only, true)
       OR EXISTS (
         SELECT 1
           FROM public.sync_runs sr
          WHERE sr.id = cs.sync_run_id
            AND sr.status = 'completed'
       )
     )
     AND (
       p_after_captured_at IS NULL
       OR p_after_id IS NULL
       OR (
         COALESCE(p_newest_first, true)
         AND (
           cs.captured_at < p_after_captured_at
           OR (cs.captured_at = p_after_captured_at AND cs.id < p_after_id)
         )
       )
       OR (
         NOT COALESCE(p_newest_first, true)
         AND (
           cs.captured_at > p_after_captured_at
           OR (cs.captured_at = p_after_captured_at AND cs.id > p_after_id)
         )
       )
     )
   ORDER BY
     CASE WHEN COALESCE(p_newest_first, true) THEN cs.captured_at END DESC,
     CASE WHEN COALESCE(p_newest_first, true) THEN cs.id END DESC,
     CASE WHEN NOT COALESCE(p_newest_first, true) THEN cs.captured_at END ASC,
     CASE WHEN NOT COALESCE(p_newest_first, true) THEN cs.id END ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.club_snapshot_page(uuid[], timestamptz, boolean, boolean, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.club_snapshot_page(uuid[], timestamptz, boolean, boolean, integer, timestamptz, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_snapshot_page(uuid[], timestamptz, boolean, boolean, integer, timestamptz, uuid) TO service_role;
COMMENT ON FUNCTION public.club_snapshot_page(uuid[], timestamptz, boolean, boolean, integer, timestamptz, uuid) IS
  'Return a bounded, keyset-paged club snapshot history only for an explicit club scope, optionally restricted to completed runs.';

-- ---------------------------------------------------------------------------
-- Finding 16: one guild eligibility source. Clubs owned by the guild define
-- the scope; only open memberships and active verifications are eligible.
-- verified_at is normalized to -infinity for keyset paging so legacy NULL
-- timestamps stay deterministic instead of being silently skipped.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_guild_verified_links(
  p_guild_id text,
  p_limit integer DEFAULT 1000,
  p_after_verified_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  verification_id uuid,
  player_id uuid,
  is_main boolean,
  method text,
  verified_at timestamptz,
  tag text,
  name text,
  discord_user_id text,
  username text
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
  ),
  eligible_players AS (
    SELECT DISTINCT m.player_id
      FROM public.club_memberships m
      JOIN scoped_clubs sc ON sc.id = m.club_id
     WHERE m.valid_to IS NULL
       AND m.player_id IS NOT NULL
  )
  SELECT pv.id AS verification_id,
         pv.player_id,
         pv.is_main,
         pv.method,
         pv.verified_at,
         p.tag,
         p.name,
         pr.discord_user_id,
         pr.username
    FROM public.player_verifications pv
    JOIN eligible_players ep ON ep.player_id = pv.player_id
    JOIN public.players p ON p.id = pv.player_id
    LEFT JOIN public.profiles pr ON pr.id = pv.profile_id
   WHERE pv.status = 'active'
     AND (
       p_after_id IS NULL
       OR COALESCE(pv.verified_at, '-infinity'::timestamptz) < COALESCE(p_after_verified_at, '-infinity'::timestamptz)
       OR (
         COALESCE(pv.verified_at, '-infinity'::timestamptz) = COALESCE(p_after_verified_at, '-infinity'::timestamptz)
         AND pv.id < p_after_id
       )
     )
   ORDER BY COALESCE(pv.verified_at, '-infinity'::timestamptz) DESC, pv.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.list_guild_verified_links(text, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_guild_verified_links(text, integer, timestamptz, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_guild_verified_links(text, integer, timestamptz, uuid) TO service_role;
COMMENT ON FUNCTION public.list_guild_verified_links(text, integer, timestamptz, uuid) IS
  'Return one keyset page of active verified links for players with open memberships in guild-owned clubs, including main flag and player/profile identity.';

-- Rank source for club roles. Keyset is the membership id because one player
-- can hold several open club memberships with different official ranks.
CREATE OR REPLACE FUNCTION public.guild_club_member_roles(
  p_guild_id text,
  p_player_ids uuid[],
  p_limit integer DEFAULT 1000,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (membership_id uuid, player_id uuid, role text)
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
  SELECT m.id AS membership_id, m.player_id, m.role
    FROM public.club_memberships m
    JOIN scoped_clubs sc ON sc.id = m.club_id
   WHERE COALESCE(array_length(p_player_ids, 1), 0) > 0
     AND m.player_id = ANY (p_player_ids)
     AND m.valid_to IS NULL
     AND m.player_id IS NOT NULL
     AND (p_after_id IS NULL OR m.id > p_after_id)
   ORDER BY m.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.guild_club_member_roles(text, uuid[], integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guild_club_member_roles(text, uuid[], integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guild_club_member_roles(text, uuid[], integer, uuid) TO service_role;
COMMENT ON FUNCTION public.guild_club_member_roles(text, uuid[], integer, uuid) IS
  'Return a keyset page of open official club ranks for the requested players, scoped to clubs registered to one guild.';

-- ---------------------------------------------------------------------------
-- Finding 17: only ask the ledger about observed candidate keys. The bounded
-- jsonb input and EXISTS filter keep dedupe SQL-side; a capped ledger read can
-- no longer make an already-delivered event look new.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.club_log_delivered_keys(
  p_guild_id text,
  p_log_id uuid,
  p_period text,
  p_candidate_keys jsonb,
  p_limit integer DEFAULT 1000
)
RETURNS TABLE (event_kind text, event_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidate AS (
    SELECT k.kind AS event_kind, k.id AS event_id
      FROM jsonb_to_recordset(
        CASE WHEN jsonb_typeof(p_candidate_keys) = 'array' THEN p_candidate_keys ELSE '[]'::jsonb END
      ) AS k(kind text, id uuid)
     WHERE k.kind IN ('membership', 'role', 'capacity')
       AND k.id IS NOT NULL
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000)
  )
  SELECT c.event_kind, c.event_id
    FROM candidate c
   WHERE NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NOT NULL
     AND p_log_id IS NOT NULL
     AND p_period IN ('today', 'week', 'season')
     AND EXISTS (
       SELECT 1
         FROM public.guild_club_log_deliveries d
        WHERE d.guild_id = btrim(p_guild_id)
          AND d.log_id = p_log_id
          AND d.period = p_period
          AND d.event_kind = c.event_kind
          AND d.event_id = c.event_id
     );
$$;

REVOKE ALL ON FUNCTION public.club_log_delivered_keys(text, uuid, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.club_log_delivered_keys(text, uuid, text, jsonb, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_log_delivered_keys(text, uuid, text, jsonb, integer) TO service_role;
COMMENT ON FUNCTION public.club_log_delivered_keys(text, uuid, text, jsonb, integer) IS
  'Return only the bounded candidate event keys already delivered for one guild log and period; empty or invalid scopes return no keys.';
