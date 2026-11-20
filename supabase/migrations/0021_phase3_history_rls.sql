-- Phase 3 hardening: scope stored player history to the clubs a web user can read.
-- Applied migrations remain untouched; this migration replaces only the two broad
-- SELECT policies that exposed every player's snapshots and battle log rows.

CREATE OR REPLACE FUNCTION public.has_player_access(target_user_id uuid, target_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_global_staff(target_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.club_memberships cm
      WHERE cm.player_id = target_player_id
        AND public.has_club_access(target_user_id, cm.club_id)
    );
$$;

REVOKE ALL ON FUNCTION public.has_player_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_player_access(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS player_snapshots_select_authenticated ON public.player_snapshots;
CREATE POLICY player_snapshots_select_authenticated
  ON public.player_snapshots FOR SELECT
  TO authenticated
  USING (public.has_player_access(auth.uid(), player_id));

DROP POLICY IF EXISTS player_battles_select_authenticated ON public.player_battles;
CREATE POLICY player_battles_select_authenticated
  ON public.player_battles FOR SELECT
  TO authenticated
  USING (public.has_player_access(auth.uid(), player_id));
