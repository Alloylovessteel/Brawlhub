-- Recoverable nickname cycles after release. Additive only; migrations
-- 0001-0062 are untouched. A released row may only become active again when a
-- new Discord write is confirmed with the exact nickname that was observed
-- before that write. The pre-send intent alone is never proof.

-- Confirm an applied nickname cycle. `p_expected_applied_nickname` ties the
-- confirmation to the nickname actually present in Discord. A released row can
-- settle only its own pending cycle; an already-confirmed released row stays
-- released. Metadata for a pending cycle comes from the intent, not from the
-- later confirmation call, so a prefix change cannot be reported as applied.
CREATE OR REPLACE FUNCTION public.managed_nickname_mark_applied(
  p_guild_id text,
  p_discord_user_id text,
  p_cycle_id uuid,
  p_source text,
  p_source_id text,
  p_player_id uuid,
  p_player_tag text,
  p_player_name text,
  p_prefix text,
  p_expected_applied_nickname text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated text;
BEGIN
  IF NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_discord_user_id, '')), '') IS NULL
     OR p_cycle_id IS NULL THEN
    RAISE EXCEPTION 'Nickname confirmation requires guild, user and cycle' USING ERRCODE = '22023';
  END IF;

  UPDATE public.guild_managed_nicknames n
     SET cycle_id = CASE
                      WHEN n.pending_cycle_id = p_cycle_id THEN p_cycle_id
                      ELSE n.cycle_id
                    END,
         confirmed_at = CASE
                          WHEN n.pending_cycle_id = p_cycle_id THEN now()
                          ELSE n.confirmed_at
                        END,
         released_at = CASE
                         WHEN n.pending_cycle_id = p_cycle_id THEN NULL
                         ELSE n.released_at
                       END,
         applied_nickname = CASE
                              WHEN n.pending_cycle_id = p_cycle_id
                                THEN COALESCE(n.pending_applied_nickname, n.applied_nickname)
                              ELSE n.applied_nickname
                            END,
         previous_nickname = CASE
                               WHEN n.pending_cycle_id = p_cycle_id
                                 THEN n.pending_previous_nickname
                               ELSE n.previous_nickname
                             END,
         pending_cycle_id = NULL,
         pending_applied_nickname = NULL,
         pending_previous_nickname = NULL,
         source = CASE
                    WHEN n.pending_cycle_id = p_cycle_id THEN n.source
                    ELSE p_source
                  END,
         source_id = CASE
                       WHEN n.pending_cycle_id = p_cycle_id THEN n.source_id
                       ELSE p_source_id
                     END,
         player_id = CASE
                       WHEN n.pending_cycle_id = p_cycle_id THEN n.player_id
                       ELSE p_player_id
                     END,
         player_tag = CASE
                        WHEN n.pending_cycle_id = p_cycle_id THEN n.player_tag
                        ELSE p_player_tag
                      END,
         player_name = CASE
                         WHEN n.pending_cycle_id = p_cycle_id THEN n.player_name
                         ELSE p_player_name
                       END,
         prefix = CASE
                    WHEN n.pending_cycle_id = p_cycle_id THEN n.prefix
                    ELSE p_prefix
                  END,
         updated_at = now(),
         last_seen_at = now()
   WHERE n.guild_id = btrim(p_guild_id)
     AND n.discord_user_id = btrim(p_discord_user_id)
     AND (
       (
         n.pending_cycle_id = p_cycle_id
         AND (
           p_expected_applied_nickname IS NULL
           OR n.pending_applied_nickname = p_expected_applied_nickname
         )
       )
       OR (
         n.released_at IS NULL
         AND n.cycle_id = p_cycle_id
         AND n.pending_cycle_id IS NULL
       )
     )
   RETURNING n.discord_user_id INTO v_updated;

  RETURN v_updated IS NOT NULL;
END;
$$;

-- Preserve the older nine-argument call shape as a compatibility wrapper.
CREATE OR REPLACE FUNCTION public.managed_nickname_mark_applied(
  p_guild_id text,
  p_discord_user_id text,
  p_cycle_id uuid,
  p_source text,
  p_source_id text,
  p_player_id uuid,
  p_player_tag text,
  p_player_name text,
  p_prefix text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.managed_nickname_mark_applied(
    p_guild_id,
    p_discord_user_id,
    p_cycle_id,
    p_source,
    p_source_id,
    p_player_id,
    p_player_tag,
    p_player_name,
    p_prefix,
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text, text) IS
  'Confirm an exact nickname cycle, optionally requiring the nickname observed before confirmation; a released row is reactivated only by its own verified pending cycle.';

-- Keyset discovery for guilds that still have active managed nicknames. Used by
-- the scheduled cleanup pass so a disabled guild with failed cleanup is retried.
CREATE OR REPLACE FUNCTION public.guilds_with_active_managed_nicknames(
  p_limit integer DEFAULT 1000,
  p_after_guild_id text DEFAULT NULL
)
RETURNS TABLE (guild_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.guild_id
    FROM public.guild_managed_nicknames n
   WHERE n.released_at IS NULL
     AND (p_after_guild_id IS NULL OR n.guild_id > p_after_guild_id)
   GROUP BY n.guild_id
   ORDER BY n.guild_id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.guilds_with_active_managed_nicknames(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guilds_with_active_managed_nicknames(integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guilds_with_active_managed_nicknames(integer, text) TO service_role;

COMMENT ON FUNCTION public.guilds_with_active_managed_nicknames(integer, text) IS
  'Return one keyset page of guild ids with active managed nicknames, including guilds whose automatic nickname sync is disabled.';

NOTIFY pgrst, 'reload schema';
