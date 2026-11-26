-- 0051 was published with report-period eligibility based on period_start.
-- That rule skipped a period which was already in progress when a guild first
-- enabled reports. Reapply only the corrected delivery eligibility here so the
-- published 0051 migration can remain byte-for-byte unchanged. Databases that
-- recorded the temporarily edited 0051 checksum need a one-time checksum
-- repair before this additive migration can run.

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
       -- Keep the period that was in progress at opt-in (its end is after
       -- reports_enabled_at) while suppressing periods that had already
       -- ended before opt-in.
       AND r.period_end > gs.reports_enabled_at
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

REVOKE ALL ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) TO service_role;

COMMENT ON FUNCTION public.push_missing_report_deliveries(jsonb, integer, text, text, text) IS
  'Return keyset pages of opted-in guild/period deliveries still missing; a period is due when it ended after opt-in.';
