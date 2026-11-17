-- Phase 3 hardening: scope event history to clubs the user can access and
-- restrict audit logs to the Server Owner role.

CREATE OR REPLACE FUNCTION public.is_global_owner(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = target_user_id
      AND scope = 'global'
      AND role = 'owner'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_global_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_global_owner(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS membership_events_select_authenticated ON public.membership_events;
CREATE POLICY membership_events_select_authenticated
  ON public.membership_events FOR SELECT
  TO authenticated
  USING (
    is_global_staff(auth.uid())
    OR (from_club_id IS NOT NULL AND has_club_access(auth.uid(), from_club_id))
    OR (to_club_id IS NOT NULL AND has_club_access(auth.uid(), to_club_id))
  );

DROP POLICY IF EXISTS audit_logs_select ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_select_global_staff ON public.audit_logs;
CREATE POLICY audit_logs_select_owner
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (is_global_owner(auth.uid()));
