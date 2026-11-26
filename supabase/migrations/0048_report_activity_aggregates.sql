-- Corrective hardening for the 67e535f rescan findings 6, 7 and 13.
--
-- Report data is aggregated in SQL over the full guild/period scope instead of
-- loading capped REST pages and counting them in the bot. The club list is also
-- returned by an RPC so active clubs are never silently limited to 25.

CREATE OR REPLACE FUNCTION public.push_report_clubs(p_guild_id text)
RETURNS TABLE (id uuid, tag text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.tag, c.name
    FROM public.clubs c
   WHERE c.guild_id = p_guild_id
     AND c.archived_at IS NULL
   ORDER BY c.name ASC, c.id ASC;
$$;

REVOKE ALL ON FUNCTION public.push_report_clubs(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.push_report_clubs(text) TO service_role;

CREATE OR REPLACE FUNCTION public.push_report_activity(
  p_guild_id text,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (
  club_id uuid,
  joins bigint,
  leaves bigint,
  transfers bigint,
  role_changes bigint,
  capacity_opens bigint,
  capacity_closes bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped_clubs AS (
    SELECT c.id
      FROM public.clubs c
     WHERE c.guild_id = p_guild_id
       AND c.archived_at IS NULL
  ),
  incoming AS (
    SELECT me.to_club_id AS club_id, count(DISTINCT me.id) AS total
      FROM public.membership_events me
      JOIN scoped_clubs sc ON sc.id = me.to_club_id
     WHERE me.event_type = 'join'
       AND me.detected_at >= p_start
       AND me.detected_at < p_end
     GROUP BY me.to_club_id
  ),
  outgoing AS (
    SELECT me.from_club_id AS club_id, count(DISTINCT me.id) AS total
      FROM public.membership_events me
      JOIN scoped_clubs sc ON sc.id = me.from_club_id
     WHERE me.event_type = 'leave'
       AND me.detected_at >= p_start
       AND me.detected_at < p_end
     GROUP BY me.from_club_id
  ),
  transfer_sides AS (
    SELECT me.id, me.from_club_id AS club_id
      FROM public.membership_events me
      JOIN scoped_clubs sc ON sc.id = me.from_club_id
     WHERE me.event_type = 'transfer'
       AND me.detected_at >= p_start
       AND me.detected_at < p_end
    UNION ALL
    SELECT me.id, me.to_club_id AS club_id
      FROM public.membership_events me
      JOIN scoped_clubs sc ON sc.id = me.to_club_id
     WHERE me.event_type = 'transfer'
       AND me.detected_at >= p_start
       AND me.detected_at < p_end
  ),
  transfers AS (
    SELECT ts.club_id, count(DISTINCT ts.id) AS total
      FROM transfer_sides ts
     GROUP BY ts.club_id
  ),
  roles AS (
    SELECT crc.club_id, count(*) AS total
      FROM public.club_role_changes crc
      JOIN scoped_clubs sc ON sc.id = crc.club_id
     WHERE crc.detected_at >= p_start
       AND crc.detected_at < p_end
     GROUP BY crc.club_id
  ),
  capacity_opens AS (
    SELECT cce.club_id, count(*) AS total
      FROM public.club_capacity_events cce
      JOIN scoped_clubs sc ON sc.id = cce.club_id
     WHERE cce.is_full IS FALSE
       AND cce.detected_at >= p_start
       AND cce.detected_at < p_end
     GROUP BY cce.club_id
  ),
  capacity_closes AS (
    SELECT cce.club_id, count(*) AS total
      FROM public.club_capacity_events cce
      JOIN scoped_clubs sc ON sc.id = cce.club_id
     WHERE cce.is_full IS TRUE
       AND cce.detected_at >= p_start
       AND cce.detected_at < p_end
     GROUP BY cce.club_id
  ),
  per_club AS (
    SELECT sc.id,
           COALESCE(i.total, 0) AS joins,
           COALESCE(o.total, 0) AS leaves,
           COALESCE(t.total, 0) AS transfers,
           COALESCE(r.total, 0) AS role_changes,
           COALESCE(co.total, 0) AS capacity_opens,
           COALESCE(cc.total, 0) AS capacity_closes
      FROM scoped_clubs sc
      LEFT JOIN incoming i ON i.club_id = sc.id
      LEFT JOIN outgoing o ON o.club_id = sc.id
      LEFT JOIN transfers t ON t.club_id = sc.id
      LEFT JOIN roles r ON r.club_id = sc.id
      LEFT JOIN capacity_opens co ON co.club_id = sc.id
      LEFT JOIN capacity_closes cc ON cc.club_id = sc.id
  ),
  guild_total AS (
    SELECT NULL::uuid AS id,
           COALESCE(sum(joins), 0) AS joins,
           COALESCE(sum(leaves), 0) AS leaves,
           (SELECT count(DISTINCT ts.id) FROM transfer_sides ts) AS transfers,
           COALESCE(sum(role_changes), 0) AS role_changes,
           COALESCE(sum(capacity_opens), 0) AS capacity_opens,
           COALESCE(sum(capacity_closes), 0) AS capacity_closes
      FROM per_club
  )
  SELECT id, joins, leaves, transfers, role_changes, capacity_opens, capacity_closes
    FROM per_club
  UNION ALL
  SELECT id, joins, leaves, transfers, role_changes, capacity_opens, capacity_closes
    FROM guild_total
   ORDER BY id NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.push_report_clubs(text) IS
  'Return every active club for a guild without a REST row cap.';
COMMENT ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz) IS
  'Aggregate scoped report activity in SQL so busy periods cannot be undercounted by REST limits.';
