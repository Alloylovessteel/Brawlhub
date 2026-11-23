-- Idempotency ledger for scheduled club trophy digests. Unlike the event
-- ledger (which tracks individual change IDs), a digest is posted once per
-- completed UTC window, so restarts and overlapping polls cannot repost it.
CREATE TABLE IF NOT EXISTS public.guild_club_log_digest_posts (
  guild_id text NOT NULL,
  log_id uuid NOT NULL REFERENCES public.guild_club_logs(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('today', 'week', 'season')),
  period_key text NOT NULL,
  channel_id text NOT NULL,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, log_id, period, period_key)
);

ALTER TABLE public.guild_club_log_digest_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_club_log_digest_posts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_club_log_digest_posts TO service_role;
