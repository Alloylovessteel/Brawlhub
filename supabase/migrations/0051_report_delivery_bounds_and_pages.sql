-- Rescan findings 2, 4 and 5: bound report catch-up, page delivery discovery,
-- and page report aggregates so PostgREST's REST row cap cannot truncate them.

-- ---------------------------------------------------------------------------
-- Finding 2: only guilds that opted in after reports_enabled_at are due.
-- ---------------------------------------------------------------------------

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS reports_enabled_at timestamptz;

COMMENT ON COLUMN public.guild_settings.reports_enabled_at IS
  'First time a report-capable channel was configured; NULL means the guild has not opted in to reports.';

CREATE OR REPLACE FUNCTION public.touch_guild_reports_enabled_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.reports_enabled_at IS NULL AND (
       NULLIF(btrim(NEW.overview_channel_id), '') IS NOT NULL
    OR NULLIF(btrim(NEW.report_daily_channel_id), '') IS NOT NULL
    OR NULLIF(btrim(NEW.report_weekly_channel_id), '') IS NOT NULL
    OR NULLIF(btrim(NEW.report_monthly_channel_id), '') IS NOT NULL
  ) THEN
    NEW.reports_enabled_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guild_settings_touch_reports_enabled_at ON public.guild_settings;
CREATE TRIGGER guild_settings_touch_reports_enabled_at
  BEFORE INSERT OR UPDATE OF overview_channel_id,
                           report_daily_channel_id,
                           report_weekly_channel_id,
                           report_monthly_channel_id
  ON public.guild_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_guild_reports_enabled_at();

-- Existing configured guilds are opted in as of deployment; because the RPC
-- only allows period_start >= reports_enabled_at, historical catch-up is
-- intentionally suppressed for them.
UPDATE public.guild_settings
   SET reports_enabled_at = now()
 WHERE reports_enabled_at IS NULL
   AND (
        NULLIF(btrim(overview_channel_id), '') IS NOT NULL
     OR NULLIF(btrim(report_daily_channel_id), '') IS NOT NULL
     OR NULLIF(btrim(report_weekly_channel_id), '') IS NOT NULL
     OR NULLIF(btrim(report_monthly_channel_id), '') IS NOT NULL
   );

-- ---------------------------------------------------------------------------
-- Finding 4: delivery state is filtered in SQL and read by keyset pages.
-- ---------------------------------------------------------------------------

-- Mirrors the bot's claim semantics: plain IDs and claim-delivered sentinels
-- carrying a Discord message ID are delivered; staged/legacy claims are not.
CREATE OR REPLACE FUNCTION public.report_ledger_message_is_delivered(p_message_id text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix constant text := 'claim-delivered:';
  v_suffix text;
  v_separator integer;
BEGIN
  IF p_message_id IS NULL THEN
    RETURN false;
  END IF;
  IF left(p_message_id, length(v_prefix)) = v_prefix THEN
    v_suffix := substring(p_message_id from length(v_prefix) + 1);
    v_separator := position(':' in v_suffix);
    IF v_separator = 0 THEN
      RETURN false;
    END IF;
    RETURN length(substring(v_suffix from v_separator + 1)) > 0;
  END IF;
  RETURN left(p_message_id, length('claim:')) <> 'claim:';
END;
$$;

CREATE OR REPLACE FUNCTION public.push_missing_report_deliveries(
  p_periods jsonb,
  p_limit integer DEFAULT 1000,
  p_after_guild_id text DEFAULT NULL,
  p_after_report_type text DEFAULT NULL,
  p_after_period_key text DEFAULT NULL
)
RETURNS TABLE (
  guild_id text,
  report_type text,
  period_key text,
  period_start timestamptz,
  period_end timestamptz,
  channel_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT p.type,
           p.period_key,
           p.period_start,
           p.period_end
      FROM jsonb_to_recordset(p_periods)
             AS p(type text, period_key text, period_start timestamptz, period_end timestamptz)
     WHERE p.type IN ('daily', 'weekly', 'monthly')
       AND p.period_key IS NOT NULL
       AND p.period_start IS NOT NULL
       AND p.period_end IS NOT NULL
  ),
  eligible AS (
    SELECT gs.guild_id,
           r.type,
           r.period_key,
           r.period_start,
           r.period_end,
           CASE r.type WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END AS type_rank,
           COALESCE(
             NULLIF(btrim(
               CASE r.type
                 WHEN 'daily' THEN gs.report_daily_channel_id
                 WHEN 'weekly' THEN gs.report_weekly_channel_id
                 ELSE gs.report_monthly_channel_id
               END
             ), ''),
             NULLIF(btrim(gs.overview_channel_id), '')
           ) AS channel_id
      FROM public.guild_settings gs
      JOIN requested r ON true
     WHERE gs.reports_enabled_at IS NOT NULL
       AND r.period_start >= gs.reports_enabled_at
  ),
  missing AS (
    SELECT e.*
      FROM eligible e
     WHERE e.channel_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.guild_report_posts grp
          WHERE grp.guild_id = e.guild_id
            AND grp.report_type = e.type
            AND grp.period_key = e.period_key
            AND public.report_ledger_message_is_delivered(grp.message_id)
       )
  )
  SELECT m.guild_id,
         m.type AS report_type,
         m.period_key,
         m.period_start,
         m.period_end,
         m.channel_id
    FROM missing m
   WHERE p_after_guild_id IS NULL
      OR (
           p_after_report_type IS NOT NULL
           AND p_after_period_key IS NOT NULL
           AND (
             m.guild_id > p_after_guild_id
             OR (m.guild_id = p_after_guild_id AND m.type_rank > (
               CASE p_after_report_type WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END
             ))
             OR (m.guild_id = p_after_guild_id
                 AND m.type = p_after_report_type
                 AND m.period_key > p_after_period_key)
           )
         )
   ORDER BY m.guild_id, m.type_rank, m.period_key
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.push_missing_inactivity_deliveries(
  p_period_key text,
  p_limit integer DEFAULT 1000,
  p_after_guild_id text DEFAULT NULL
)
RETURNS TABLE (guild_id text, period_key text, channel_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH missing AS (
    SELECT gs.guild_id,
           p_period_key AS period_key,
           COALESCE(
             NULLIF(btrim(gs.report_inactivity_channel_id), ''),
             NULLIF(btrim(gs.overview_channel_id), '')
           ) AS channel_id
      FROM public.guild_settings gs
     WHERE gs.reports_enabled_at IS NOT NULL
       AND gs.report_inactivity_days BETWEEN 1 AND 365
       AND p_period_key IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.guild_inactivity_report_posts ip
          WHERE ip.guild_id = gs.guild_id
            AND ip.period_key = p_period_key
            AND public.report_ledger_message_is_delivered(ip.message_id)
       )
  )
  SELECT m.guild_id, m.period_key, m.channel_id
    FROM missing m
   WHERE m.channel_id IS NOT NULL
     AND (p_after_guild_id IS NULL OR m.guild_id > p_after_guild_id)
   ORDER BY m.guild_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

-- ---------------------------------------------------------------------------
-- Finding 5: page report aggregates instead of returning a capped REST table.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.push_report_clubs(text);
DROP FUNCTION IF EXISTS public.push_report_activity(text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.push_report_clubs(
  p_guild_id text,
  p_limit integer DEFAULT 1000,
  p_after_name text DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
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
     AND (
       p_after_name IS NULL
       OR c.name > p_after_name
       OR (c.name = p_after_name AND c.id > p_after_id)
     )
   ORDER BY c.name ASC, c.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.push_report_activity(
  p_guild_id text,
  p_start timestamptz,
  p_end timestamptz,
  p_limit integer DEFAULT 1000,
  p_after_id uuid DEFAULT NULL
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
  )
  SELECT pc.id,
         pc.joins,
         pc.leaves,
         pc.transfers,
         pc.role_changes,
         pc.capacity_opens,
         pc.capacity_closes
    FROM per_club pc
   WHERE p_after_id IS NULL OR pc.id > p_after_id
   ORDER BY pc.id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.push_report_activity_totals(
  p_guild_id text,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (
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
  SELECT joins, leaves, transfers, role_changes, capacity_opens, capacity_closes
    FROM guild_total;
$$;

-- ---------------------------------------------------------------------------
-- Trusted callers only.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.touch_guild_reports_enabled_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_ledger_message_is_delivered(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_missing_inactivity_deliveries(text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_report_clubs(text, integer, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_report_activity_totals(text, timestamptz, timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.touch_guild_reports_enabled_at() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.report_ledger_message_is_delivered(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_missing_inactivity_deliveries(text, integer, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_report_clubs(text, integer, text, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz, integer, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.push_report_activity_totals(text, timestamptz, timestamptz) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.touch_guild_reports_enabled_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.report_ledger_message_is_delivered(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_missing_inactivity_deliveries(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_report_clubs(text, integer, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_report_activity_totals(text, timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.touch_guild_reports_enabled_at() IS
  'Set reports_enabled_at when a guild first configures a report-capable channel.';
COMMENT ON FUNCTION public.report_ledger_message_is_delivered(text) IS
  'True for a plain Discord message ID or a delivered claim sentinel carrying a message ID.';
COMMENT ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) IS
  'Return keyset pages of opted-in guild/period report deliveries that are still missing.';
COMMENT ON FUNCTION public.push_missing_inactivity_deliveries(text, integer, text) IS
  'Return keyset pages of opted-in guilds still missing a durable inactivity post for the day.';
COMMENT ON FUNCTION public.push_report_clubs(text, integer, text, uuid) IS
  'Return a keyset page of active clubs for a guild without a REST row cap.';
COMMENT ON FUNCTION public.push_report_activity(text, timestamptz, timestamptz, integer, uuid) IS
  'Return one keyset page of per-club report activity aggregated in SQL.';
COMMENT ON FUNCTION public.push_report_activity_totals(text, timestamptz, timestamptz) IS
  'Return guild-wide report totals, counting cross-club transfers once.';
