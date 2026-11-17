-- Phase 3: RLS hardening for dashboard reads and Discord-derived role sync.
-- Dashboard reads use user-scoped clients. Service-role writes remain trusted.

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'discord';

DO $$
BEGIN
  ALTER TABLE public.user_roles
    ADD CONSTRAINT user_roles_source_check CHECK (source IN ('discord', 'manual'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- sync_locks was added after the original grant cleanup. Make it service-only.
REVOKE ALL ON TABLE public.sync_locks FROM anon, authenticated;
GRANT ALL ON TABLE public.sync_locks TO service_role;

-- Allow verified, authenticated members to read real collected history.
GRANT SELECT ON TABLE public.membership_events TO authenticated;
GRANT SELECT ON TABLE public.club_snapshots TO authenticated;
GRANT SELECT ON TABLE public.player_snapshots TO authenticated;
GRANT SELECT ON TABLE public.sync_runs TO authenticated;
GRANT SELECT ON TABLE public.user_roles TO authenticated;
GRANT SELECT ON TABLE public.discord_users TO authenticated;

DROP POLICY IF EXISTS membership_events_select_authenticated ON public.membership_events;
CREATE POLICY membership_events_select_authenticated
  ON public.membership_events FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS club_snapshots_select_authenticated ON public.club_snapshots;
CREATE POLICY club_snapshots_select_authenticated
  ON public.club_snapshots FOR SELECT
  TO authenticated
  USING (has_club_access(auth.uid(), club_id));

DROP POLICY IF EXISTS player_snapshots_select_authenticated ON public.player_snapshots;
CREATE POLICY player_snapshots_select_authenticated
  ON public.player_snapshots FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS sync_runs_select_authenticated ON public.sync_runs;
CREATE POLICY sync_runs_select_authenticated
  ON public.sync_runs FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS notifications_select_global_staff ON public.notifications;
CREATE POLICY notifications_select_global_staff
  ON public.notifications FOR SELECT
  TO authenticated
  USING (is_global_staff(auth.uid()));

DROP POLICY IF EXISTS user_roles_select_own_or_global_staff ON public.user_roles;
CREATE POLICY user_roles_select_own_or_global_staff
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR is_global_staff(auth.uid()));

DROP POLICY IF EXISTS discord_users_select_own_or_global_staff ON public.discord_users;
CREATE POLICY discord_users_select_own_or_global_staff
  ON public.discord_users FOR SELECT
  TO authenticated
  USING (profile_id = auth.uid() OR is_global_staff(auth.uid()));

-- Allow a newly authenticated user to create their own profile. The OAuth
-- callback normally provisions it with the service role first.
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());
