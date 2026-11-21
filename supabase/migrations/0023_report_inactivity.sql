-- Additive: per-guild inactivity report configuration.
-- NULL report_inactivity_days means the digest is disabled for that guild.
-- A dedicated ledger keeps this new schedule isolated from the existing
-- daily/weekly/monthly report ledger and its type constraint.

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS report_inactivity_days integer;

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS report_inactivity_channel_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'guild_settings_report_inactivity_days_check'
  ) THEN
    ALTER TABLE public.guild_settings
      ADD CONSTRAINT guild_settings_report_inactivity_days_check
      CHECK (report_inactivity_days IS NULL OR report_inactivity_days BETWEEN 1 AND 365);
  END IF;
END $$;

COMMENT ON COLUMN public.guild_settings.report_inactivity_days IS
  'Days without a stored battle before a member is flagged inactive; NULL disables the digest.';
COMMENT ON COLUMN public.guild_settings.report_inactivity_channel_id IS
  'Optional channel override for the inactivity digest; falls back to the overview channel.';

CREATE TABLE IF NOT EXISTS public.guild_inactivity_report_posts (
  guild_id text NOT NULL,
  period_key text NOT NULL,
  channel_id text NOT NULL,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, period_key)
);

ALTER TABLE public.guild_inactivity_report_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_inactivity_report_posts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_inactivity_report_posts TO service_role;
