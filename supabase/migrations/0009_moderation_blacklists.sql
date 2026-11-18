-- ---------------------------------------------------------------------------
-- Task 10: moderation blacklist history and atomic mutations.
--
-- This migration is local only. It must not be applied as part of Task 10 and
-- no command that calls the new RPCs may be enabled until it has been applied.
-- ---------------------------------------------------------------------------

-- Preserve the original blacklist row when an entry is removed. Existing rows
-- are classified as active because the previous schema had no removal state.
ALTER TABLE public.blacklists
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removal_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.blacklists
  DROP CONSTRAINT IF EXISTS blacklists_status_check;

ALTER TABLE public.blacklists
  ADD CONSTRAINT blacklists_status_check
  CHECK (status IN ('active', 'removed', 'expired'));

CREATE INDEX IF NOT EXISTS idx_blacklists_status_created
  ON public.blacklists (status, created_at DESC);

-- At most one active entry per target. Blacklists are global-only, so these
-- indexes are intentionally not scoped by club.
CREATE UNIQUE INDEX IF NOT EXISTS uq_blacklists_active_player
  ON public.blacklists (player_id)
  WHERE status = 'active' AND player_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_blacklists_active_discord
  ON public.blacklists (discord_user_id)
  WHERE status = 'active' AND discord_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_blacklists_updated_at ON public.blacklists;
CREATE TRIGGER trg_blacklists_updated_at
  BEFORE UPDATE ON public.blacklists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Authorization helpers.
--
-- is_global_admin is granted to authenticated so it can be used by the tightened
-- blacklists RLS policy. can_manage_blacklists remains service-role-only and is
-- used by the trusted bot RPCs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_global_admin(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = p_profile_id
      AND scope = 'global'
      AND role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_blacklists(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_global_admin(p_profile_id);
$$;

REVOKE ALL ON FUNCTION public.is_global_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_blacklists(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_global_admin(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.can_manage_blacklists(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_global_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_blacklists(uuid) TO service_role;

-- Align database reads with the app permission matrix: global staff do not have
-- blacklists:manage, so only global owner/admin may read the table directly.
DROP POLICY IF EXISTS blacklists_select ON public.blacklists;
CREATE POLICY blacklists_select
  ON public.blacklists FOR SELECT TO authenticated
  USING (public.is_global_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Atomic, service-role-only mutations. Each RPC rechecks permission and writes
-- its audit row in the same transaction as the domain change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.moderation_blacklist_add(
  p_player_id uuid,
  p_reason text,
  p_expires_at timestamptz,
  p_actor_profile_id uuid,
  p_actor_discord_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text := btrim(p_reason);
  v_actor_discord_id text := nullif(btrim(p_actor_discord_id), '');
  v_player_tag text;
  v_id uuid;
BEGIN
  IF NOT public.can_manage_blacklists(p_actor_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_target');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 1 OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_reason');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = p_player_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'unknown_player');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.blacklists
    WHERE status = 'active' AND player_id = p_player_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'duplicate_active');
  END IF;

  SELECT tag INTO v_player_tag FROM public.players WHERE id = p_player_id;

  INSERT INTO public.blacklists (
    player_id, reason, created_by, expires_at, status
  ) VALUES (
    p_player_id, v_reason, p_actor_profile_id, p_expires_at, 'active'
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, details
  ) VALUES (
    p_actor_profile_id,
    'blacklist.added',
    'blacklist',
    v_id::text,
    jsonb_build_object(
      'playerId', p_player_id,
      'playerTag', v_player_tag,
      'reason', v_reason,
      'expiresAt', p_expires_at,
      'actorDiscordId', v_actor_discord_id,
      'createdAt', now()
    )
  );

  RETURN jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'duplicate_active');
END $$;

CREATE OR REPLACE FUNCTION public.moderation_blacklist_remove(
  p_blacklist_id uuid,
  p_removal_reason text,
  p_actor_profile_id uuid,
  p_actor_discord_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removal_reason text := nullif(btrim(p_removal_reason), '');
  v_actor_discord_id text := nullif(btrim(p_actor_discord_id), '');
  v_blacklist public.blacklists%ROWTYPE;
  v_player_tag text;
  v_removed_at timestamptz := now();
BEGIN
  IF NOT public.can_manage_blacklists(p_actor_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF v_removal_reason IS NOT NULL AND length(v_removal_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_reason');
  END IF;

  SELECT * INTO v_blacklist
  FROM public.blacklists
  WHERE id = p_blacklist_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_blacklist.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_removed');
  END IF;

  SELECT tag INTO v_player_tag FROM public.players WHERE id = v_blacklist.player_id;

  UPDATE public.blacklists
     SET status = 'removed',
         removed_at = v_removed_at,
         removed_by = p_actor_profile_id,
         removal_reason = v_removal_reason,
         updated_at = v_removed_at
   WHERE id = p_blacklist_id;

  INSERT INTO public.audit_logs (
    actor_profile_id, action, target_type, target_id, details
  ) VALUES (
    p_actor_profile_id,
    'blacklist.removed',
    'blacklist',
    p_blacklist_id::text,
    jsonb_build_object(
      'playerId', v_blacklist.player_id,
      'playerTag', v_player_tag,
      'originalReason', v_blacklist.reason,
      'removalReason', v_removal_reason,
      'removedAt', v_removed_at,
      'actorDiscordId', v_actor_discord_id
    )
  );

  RETURN jsonb_build_object('ok', true, 'id', p_blacklist_id, 'removedAt', v_removed_at);
END $$;

-- Only trusted server-side callers may mutate moderation state.
REVOKE ALL ON FUNCTION public.moderation_blacklist_add(uuid, text, timestamptz, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moderation_blacklist_remove(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moderation_blacklist_add(uuid, text, timestamptz, uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.moderation_blacklist_remove(uuid, text, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderation_blacklist_add(uuid, text, timestamptz, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.moderation_blacklist_remove(uuid, text, uuid, text) TO service_role;
