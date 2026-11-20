-- Phase 2B: per-guild overview field selection, club logs, scheduled report
-- channel overrides/deliveries, and stored role/capacity change events.
-- All changes are additive; applied migrations 0001-0019 remain untouched.

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS overview_fields text[],
  ADD COLUMN IF NOT EXISTS report_daily_channel_id text,
  ADD COLUMN IF NOT EXISTS report_weekly_channel_id text,
  ADD COLUMN IF NOT EXISTS report_monthly_channel_id text;

COMMENT ON COLUMN public.guild_settings.overview_fields IS
  'Enabled overview field keys for this guild. NULL/empty means the BrawlHub defaults.';
COMMENT ON COLUMN public.guild_settings.report_daily_channel_id IS
  'Optional daily report channel override; falls back to overview_channel_id.';
COMMENT ON COLUMN public.guild_settings.report_weekly_channel_id IS
  'Optional weekly report channel override; falls back to overview_channel_id.';
COMMENT ON COLUMN public.guild_settings.report_monthly_channel_id IS
  'Optional monthly report channel override; falls back to overview_channel_id.';

-- Per-guild club log subscriptions. A club can be logged to several channels;
-- every row is owned by exactly one Discord guild and one registered club.
CREATE TABLE IF NOT EXISTS public.guild_club_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_club_logs_unique UNIQUE (guild_id, club_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_club_logs_guild ON public.guild_club_logs (guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_club_logs_club ON public.guild_club_logs (club_id);

ALTER TABLE public.guild_club_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_club_logs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_club_logs TO service_role;

-- Role changes are not represented by membership_events (which only stores
-- join/leave/transfer), so they get their own append-only, deduped table.
CREATE TABLE IF NOT EXISTS public.club_role_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  from_role text,
  to_role text,
  source_sync_run_id uuid REFERENCES public.sync_runs(id) ON DELETE SET NULL,
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_role_changes_dedup_key
    UNIQUE NULLS NOT DISTINCT (club_id, player_id, from_role, to_role, source_sync_run_id)
);

CREATE INDEX IF NOT EXISTS idx_club_role_changes_club_time
  ON public.club_role_changes (club_id, detected_at DESC);

ALTER TABLE public.club_role_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_role_changes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.club_role_changes TO service_role;

-- Capacity open/close transitions are stored separately from raw snapshots so
-- club logs get stable event identities without reinterpreting payload history.
CREATE TABLE IF NOT EXISTS public.club_capacity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  from_count integer,
  to_count integer NOT NULL,
  is_full boolean NOT NULL,
  source_sync_run_id uuid REFERENCES public.sync_runs(id) ON DELETE SET NULL,
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_capacity_events_dedup_key
    UNIQUE (club_id, is_full, source_sync_run_id)
);

CREATE INDEX IF NOT EXISTS idx_club_capacity_events_club_time
  ON public.club_capacity_events (club_id, detected_at DESC);

ALTER TABLE public.club_capacity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_capacity_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.club_capacity_events TO service_role;

-- Delivery ledger. The guild_id is stored explicitly so every read/write can
-- be scoped to the Discord server that owns the log subscription.
CREATE TABLE IF NOT EXISTS public.guild_club_log_deliveries (
  guild_id text NOT NULL,
  log_id uuid NOT NULL REFERENCES public.guild_club_logs(id) ON DELETE CASCADE,
  event_kind text NOT NULL CHECK (event_kind IN ('membership', 'role', 'capacity')),
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, log_id, event_kind, event_id)
);

ALTER TABLE public.guild_club_log_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_club_log_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_club_log_deliveries TO service_role;

-- One auto-post per report type and UTC period; replays edit the same message.
CREATE TABLE IF NOT EXISTS public.guild_report_posts (
  guild_id text NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('daily', 'weekly', 'monthly')),
  period_key text NOT NULL,
  channel_id text NOT NULL,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, report_type, period_key)
);

ALTER TABLE public.guild_report_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_report_posts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_report_posts TO service_role;

-- Atomically close the old membership, record the role change, and open the
-- new membership row. Scoped by club/player/membership to prevent cross-guild
-- or cross-player mutation from a malformed sync payload.
CREATE OR REPLACE FUNCTION public.apply_club_role_change(
  p_club_id uuid,
  p_player_id uuid,
  p_membership_id uuid,
  p_from_role text,
  p_to_role text,
  p_detected_at timestamptz,
  p_run_id uuid,
  p_valid_from timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_change_id uuid;
BEGIN
  UPDATE public.club_memberships
     SET valid_to = p_valid_from,
         updated_at = now()
   WHERE id = p_membership_id
     AND club_id = p_club_id
     AND player_id = p_player_id
     AND valid_to IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.club_role_changes (
    club_id,
    player_id,
    from_role,
    to_role,
    source_sync_run_id,
    detected_at
  )
  VALUES (
    p_club_id,
    p_player_id,
    p_from_role,
    p_to_role,
    p_run_id,
    p_detected_at
  )
  ON CONFLICT ON CONSTRAINT club_role_changes_dedup_key
  DO UPDATE SET detected_at = EXCLUDED.detected_at
  RETURNING id INTO v_change_id;

  INSERT INTO public.club_memberships (club_id, player_id, role, valid_from, valid_to)
  SELECT p_club_id, p_player_id, p_to_role, p_valid_from, NULL
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.club_memberships
    WHERE club_id = p_club_id
      AND player_id = p_player_id
      AND valid_to IS NULL
  );

  RETURN v_change_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_club_role_change(uuid, uuid, uuid, text, text, timestamptz, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_club_role_change(uuid, uuid, uuid, text, text, timestamptz, uuid, timestamptz) TO service_role;
