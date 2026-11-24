-- 0038 created this pure role-policy helper without SECURITY DEFINER. Recreate
-- it with the same behavior and the service-role RPC hardening used by the
-- other OAuth role functions. Changing 0038 in place would invalidate its
-- recorded migration checksum, so the correction is additive.

CREATE OR REPLACE FUNCTION public.brawlhub_can_administer_role(
  p_global_role text,
  p_club_role text,
  p_scope text,
  p_target_role text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_global_role = 'owner' THEN
      CASE WHEN p_scope = 'global' THEN true
           ELSE p_target_role IN ('owner', 'staff', 'member') END
    WHEN p_global_role = 'admin' THEN
      p_scope = 'club' AND p_target_role IN ('staff', 'member')
    ELSE
      p_scope = 'club' AND p_club_role = 'owner' AND p_target_role IN ('staff', 'member')
  END;
$$;

REVOKE ALL ON FUNCTION public.brawlhub_can_administer_role(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.brawlhub_can_administer_role(text, text, text, text) TO service_role;
