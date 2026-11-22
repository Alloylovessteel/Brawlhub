-- Per-subscription club log periods. Additive only: existing log rows and their
-- delivery ledger are untouched; old subscriptions are backfilled to `today`.

CREATE TABLE IF NOT EXISTS public.guild_club_log_periods (
  guild_id text NOT NULL,
  log_id uuid NOT NULL REFERENCES public.guild_club_logs(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('today', 'week', 'season')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, log_id, period)
);

CREATE INDEX IF NOT EXISTS idx_guild_club_log_periods_guild_log
  ON public.guild_club_log_periods (guild_id, log_id);

ALTER TABLE public.guild_club_log_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_club_log_periods FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_club_log_periods TO service_role;

INSERT INTO public.guild_club_log_periods (guild_id, log_id, period)
SELECT guild_id, id, 'today'
FROM public.guild_club_logs
ON CONFLICT (guild_id, log_id, period) DO NOTHING;
