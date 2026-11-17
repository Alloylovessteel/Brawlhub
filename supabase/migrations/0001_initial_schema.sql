-- BrawlHub initial schema
-- Target: Supabase Postgres 15+
--
-- Security model:
--   - RLS is enabled on every table.
--   - Only PUBLIC tables (clubs, players) are readable by anon/authenticated
--     without a membership check.
--   - Private/staff tables require a global staff role or a matching
--     club-scoped role through SECURITY DEFINER helpers (no direct grants on
--     user_roles are needed by clients).
--   - No INSERT/UPDATE/DELETE policies exist for anon/authenticated anywhere;
--     all writes are performed by the trusted service role, which bypasses RLS.
--   - No Discord OAuth tokens are stored in this schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger helper
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tables (ordered by dependencies)
-- ---------------------------------------------------------------------------

-- Website profiles; one row per Supabase auth user, linked to a Discord user.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  discord_user_id text NOT NULL UNIQUE,
  username text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- PUBLIC: club data safe for anyone to read.
CREATE TABLE public.clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  badge_id integer,
  trophies integer,
  required_trophies integer,
  member_count integer,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- PRIVATE: club configuration that must not be exposed publicly.
CREATE TABLE public.club_private (
  club_id uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  announcement_channel_id text,
  verified_role_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- PUBLIC: player data safe for anyone to read.
CREATE TABLE public.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag text NOT NULL UNIQUE,
  name text NOT NULL,
  trophies integer,
  highest_trophies integer,
  exp_level integer,
  power_points integer,
  victories integer,
  solo_victories integer,
  team_victories integer,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- TEMPORAL: one open row per player; closed rows preserve transfer history.
CREATE TABLE public.club_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  role text,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sync bookkeeping. Created before membership_events so it can be referenced.
CREATE TABLE public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  period_start timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  records_processed integer NOT NULL DEFAULT 0,
  CONSTRAINT sync_runs_scope_period_key UNIQUE (scope, period_start)
);

-- Transfer / join / leave history. NULLS NOT DISTINCT makes retries idempotent.
CREATE TABLE public.membership_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  from_club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  to_club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('join', 'leave', 'transfer')),
  source_sync_run_id uuid REFERENCES public.sync_runs(id) ON DELETE SET NULL,
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_events_dedup_key
    UNIQUE NULLS NOT DISTINCT (player_id, event_type, from_club_id, to_club_id, source_sync_run_id)
);

CREATE TABLE public.club_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  sync_run_id uuid NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  trophies integer,
  member_count integer,
  payload_hash text NOT NULL,
  raw jsonb NOT NULL,
  CONSTRAINT club_snapshots_club_run_key UNIQUE (club_id, sync_run_id)
);

CREATE TABLE public.player_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  sync_run_id uuid NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  trophies integer,
  payload_hash text NOT NULL,
  raw jsonb NOT NULL,
  CONSTRAINT player_snapshots_player_run_key UNIQUE (player_id, sync_run_id)
);

-- Discord notification deduplication. event_id is a logical event identifier
-- (no polymorphic FK); the unique key prevents duplicate messages per channel.
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text,
  event_id uuid,
  channel_id text,
  kind text,
  discord_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_dedup_key UNIQUE (event_id, channel_id, kind)
);

-- Discord user directory cache. No OAuth tokens are stored here.
CREATE TABLE public.discord_users (
  discord_user_id text PRIMARY KEY,
  profile_id uuid UNIQUE REFERENCES public.profiles(id) ON DELETE SET NULL,
  username text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Website authorization roles. NULLS NOT DISTINCT keeps one row per
-- (user, scope, club) even when the club is null (global scope).
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('global', 'club')),
  club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'member')),
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_scope_key UNIQUE NULLS NOT DISTINCT (user_id, scope, club_id)
);

CREATE TABLE public.guild_settings (
  guild_id text PRIMARY KEY,
  primary_club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  announcement_channel_id text,
  verified_role_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.competitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  rules text,
  status text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.competition_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES public.competitions(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  score numeric,
  submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved boolean NOT NULL DEFAULT false,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competition_entries_unique UNIQUE (competition_id, player_id)
);

CREATE TABLE public.blacklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid REFERENCES public.players(id) ON DELETE CASCADE,
  discord_user_id text,
  reason text NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blacklists_target_check CHECK (player_id IS NOT NULL OR discord_user_id IS NOT NULL)
);

CREATE TABLE public.staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  title text,
  notes text, -- private
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_clubs_last_synced_at ON public.clubs (last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_players_trophies ON public.players (trophies DESC);
CREATE INDEX IF NOT EXISTS idx_players_last_synced_at ON public.players (last_synced_at DESC);

-- At most one OPEN membership per player (transfer closes the old row first).
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_memberships_open_player
  ON public.club_memberships (player_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_club_memberships_club_valid_to
  ON public.club_memberships (club_id, valid_to);
CREATE INDEX IF NOT EXISTS idx_club_memberships_player_valid_from
  ON public.club_memberships (player_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_membership_events_player_detected
  ON public.membership_events (player_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_events_source_run
  ON public.membership_events (source_sync_run_id);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON public.sync_runs (status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON public.sync_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_club_snapshots_captured_at ON public.club_snapshots (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_snapshots_captured_at ON public.player_snapshots (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_channel ON public.notifications (channel_id);
CREATE INDEX IF NOT EXISTS idx_notifications_discord_message ON public.notifications (discord_message_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_club_role ON public.user_roles (club_id, role);
CREATE INDEX IF NOT EXISTS idx_guild_settings_primary_club ON public.guild_settings (primary_club_id);

CREATE INDEX IF NOT EXISTS idx_competitions_club ON public.competitions (club_id);
CREATE INDEX IF NOT EXISTS idx_competitions_status ON public.competitions (status);
CREATE INDEX IF NOT EXISTS idx_competitions_starts_at ON public.competitions (starts_at);
CREATE INDEX IF NOT EXISTS idx_competition_entries_player ON public.competition_entries (player_id);

CREATE INDEX IF NOT EXISTS idx_blacklists_player ON public.blacklists (player_id);
CREATE INDEX IF NOT EXISTS idx_blacklists_discord_user ON public.blacklists (discord_user_id);
CREATE INDEX IF NOT EXISTS idx_blacklists_expires_at ON public.blacklists (expires_at);

CREATE INDEX IF NOT EXISTS idx_staff_members_club ON public.staff_members (club_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs (actor_profile_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_clubs_updated_at
  BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_club_private_updated_at
  BEFORE UPDATE ON public.club_private FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_players_updated_at
  BEFORE UPDATE ON public.players FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_club_memberships_updated_at
  BEFORE UPDATE ON public.club_memberships FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_membership_events_updated_at
  BEFORE UPDATE ON public.membership_events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_discord_users_updated_at
  BEFORE UPDATE ON public.discord_users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_guild_settings_updated_at
  BEFORE UPDATE ON public.guild_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_competitions_updated_at
  BEFORE UPDATE ON public.competitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_competition_entries_updated_at
  BEFORE UPDATE ON public.competition_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_staff_members_updated_at
  BEFORE UPDATE ON public.staff_members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS authorization helpers
-- SECURITY DEFINER is required because user_roles is intentionally invisible
-- to anon/authenticated (service-role only, no policies).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_global_staff(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = p_user_id
      AND ur.scope = 'global'
      AND ur.role IN ('owner', 'admin', 'staff')
  );
$$;

CREATE OR REPLACE FUNCTION public.has_club_access(p_user_id uuid, p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_global_staff(p_user_id)
    OR (
      p_club_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = p_user_id
          AND ur.scope = 'club'
          AND ur.club_id = p_club_id
          AND ur.role IN ('owner', 'admin', 'staff', 'member')
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.has_competition_access(p_user_id uuid, p_competition_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_club_access(
    p_user_id,
    (SELECT c.club_id FROM public.competitions c WHERE c.id = p_competition_id)
  );
$$;

REVOKE ALL ON FUNCTION public.is_global_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_club_access(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_competition_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_global_staff(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_club_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_competition_access(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competition_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blacklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Policies (SELECT only; all writes are service-role only)
-- ---------------------------------------------------------------------------

CREATE POLICY clubs_public_select ON public.clubs
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY players_public_select ON public.players
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

CREATE POLICY profiles_select_global_staff ON public.profiles
  FOR SELECT TO authenticated USING (public.is_global_staff(auth.uid()));

CREATE POLICY club_private_select ON public.club_private
  FOR SELECT TO authenticated USING (public.has_club_access(auth.uid(), club_id));

CREATE POLICY club_memberships_select ON public.club_memberships
  FOR SELECT TO authenticated USING (public.has_club_access(auth.uid(), club_id));

CREATE POLICY guild_settings_select ON public.guild_settings
  FOR SELECT TO authenticated USING (public.has_club_access(auth.uid(), primary_club_id));

CREATE POLICY staff_members_select ON public.staff_members
  FOR SELECT TO authenticated USING (public.has_club_access(auth.uid(), club_id));

CREATE POLICY blacklists_select ON public.blacklists
  FOR SELECT TO authenticated USING (public.is_global_staff(auth.uid()));

CREATE POLICY audit_logs_select ON public.audit_logs
  FOR SELECT TO authenticated USING (public.is_global_staff(auth.uid()));

CREATE POLICY competitions_select ON public.competitions
  FOR SELECT TO authenticated USING (public.has_club_access(auth.uid(), club_id));

CREATE POLICY competition_entries_select ON public.competition_entries
  FOR SELECT TO authenticated USING (public.has_competition_access(auth.uid(), competition_id));

-- membership_events, club_snapshots, player_snapshots, sync_runs, notifications,
-- user_roles and discord_users intentionally have NO policies in Phase 1:
-- they are service-role only. Later phases may add narrowly scoped SELECT
-- policies for authenticated club members (e.g. membership_events for a club),
-- but must never expose tokens or unrestricted history.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- PUBLIC tables: anon + authenticated may read.
REVOKE ALL ON TABLE public.clubs, public.players FROM anon, authenticated;
GRANT SELECT ON TABLE public.clubs, public.players TO anon, authenticated;

-- Private / staff tables: authenticated may read subject to RLS policies.
REVOKE ALL ON TABLE
  public.profiles,
  public.club_private,
  public.club_memberships,
  public.guild_settings,
  public.staff_members,
  public.blacklists,
  public.audit_logs,
  public.competitions,
  public.competition_entries
FROM anon, authenticated;
GRANT SELECT ON TABLE
  public.profiles,
  public.club_private,
  public.club_memberships,
  public.guild_settings,
  public.staff_members,
  public.blacklists,
  public.audit_logs,
  public.competitions,
  public.competition_entries
TO authenticated;

-- Service-role-only tables: no grants at all to anon/authenticated.
REVOKE ALL ON TABLE
  public.sync_runs,
  public.membership_events,
  public.club_snapshots,
  public.player_snapshots,
  public.notifications,
  public.discord_users,
  public.user_roles
FROM anon, authenticated;

-- The trusted service role bypasses RLS; explicit grants keep intent clear.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;
