-- Switching the main Brawl Stars account must be atomic.
--
-- A profile may have only one active row with `is_main = true`. Doing the
-- demotion and promotion as two separate client requests can leave a profile
-- with no main if the second request fails. This RPC keeps both writes in one
-- transaction; any failure rolls back the whole switch.

CREATE OR REPLACE FUNCTION public.set_player_verification_main(
  p_profile_id uuid,
  p_player_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.player_verifications
     WHERE profile_id = p_profile_id
       AND player_id = p_player_id
       AND status = 'active'
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.player_verifications
     SET is_main = false
   WHERE profile_id = p_profile_id
     AND status = 'active'
     AND is_main;

  UPDATE public.player_verifications
     SET is_main = true
   WHERE profile_id = p_profile_id
     AND player_id = p_player_id
     AND status = 'active';

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.set_player_verification_main(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_player_verification_main(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.set_player_verification_main(uuid, uuid) IS
  'Atomically demote the active main and promote the requested active link for one profile.';
