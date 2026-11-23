-- Period-scoped club log deliveries. The old ledger recorded each event once per
-- log even though one event is posted to every subscribed period. Stored rows were
-- posted to all periods configured at the time, so they are expanded to all three
-- periods here to avoid re-posting the historical backfill.

ALTER TABLE public.guild_club_log_deliveries
  ADD COLUMN IF NOT EXISTS period text NOT NULL DEFAULT 'today'
    CONSTRAINT guild_club_log_deliveries_period_check
    CHECK (period IN ('today', 'week', 'season'));

ALTER TABLE public.guild_club_log_deliveries
  DROP CONSTRAINT IF EXISTS guild_club_log_deliveries_pkey;

ALTER TABLE public.guild_club_log_deliveries
  ADD CONSTRAINT guild_club_log_deliveries_pkey
    PRIMARY KEY (guild_id, log_id, period, event_kind, event_id);

INSERT INTO public.guild_club_log_deliveries (guild_id, log_id, period, event_kind, event_id, created_at)
SELECT d.guild_id, d.log_id, p.period, d.event_kind, d.event_id, d.created_at
FROM public.guild_club_log_deliveries AS d
CROSS JOIN (VALUES ('week'), ('season')) AS p(period)
WHERE d.period = 'today'
ON CONFLICT (guild_id, log_id, period, event_kind, event_id) DO NOTHING;
