-- Nickname management needs a confirmed cycle and a recoverable pre-send
-- intent. A released row must never reactivate with its old `previous_nickname`,
-- and a Discord write whose ledger confirmation fails must be reconciled
-- without claiming an unrelated nickname.

ALTER TABLE public.guild_managed_nicknames
  ADD COLUMN IF NOT EXISTS cycle_id uuid NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS pending_cycle_id uuid NULL,
  ADD COLUMN IF NOT EXISTS pending_applied_nickname text NULL,
  ADD COLUMN IF NOT EXISTS pending_previous_nickname text NULL;

-- Existing active rows were applied by BrawlHub in the current legacy cycle.
UPDATE public.guild_managed_nicknames
   SET cycle_id = gen_random_uuid(),
       confirmed_at = COALESCE(applied_at, updated_at, now())
 WHERE cycle_id IS NULL;

ALTER TABLE public.guild_managed_nicknames
  ALTER COLUMN cycle_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN cycle_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_managed_nicknames_pending_applied_length'
       AND conrelid = 'public.guild_managed_nicknames'::regclass
  ) THEN
    ALTER TABLE public.guild_managed_nicknames
      ADD CONSTRAINT guild_managed_nicknames_pending_applied_length
      CHECK (
        pending_applied_nickname IS NULL
        OR char_length(pending_applied_nickname) BETWEEN 1 AND 32
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_managed_nicknames_pending_previous_length'
       AND conrelid = 'public.guild_managed_nicknames'::regclass
  ) THEN
    ALTER TABLE public.guild_managed_nicknames
      ADD CONSTRAINT guild_managed_nicknames_pending_previous_length
      CHECK (
        pending_previous_nickname IS NULL
        OR char_length(pending_previous_nickname) BETWEEN 1 AND 32
      );
  END IF;
END $$;

COMMENT ON COLUMN public.guild_managed_nicknames.cycle_id IS
  'Identity of the last nickname-management cycle BrawlHub actually applied and confirmed.';
COMMENT ON COLUMN public.guild_managed_nicknames.confirmed_at IS
  'When the current cycle was confirmed after Discord accepted the nickname write.';
COMMENT ON COLUMN public.guild_managed_nicknames.pending_cycle_id IS
  'Recoverable pre-send intent. Never evidence that BrawlHub changed a nickname.';
COMMENT ON COLUMN public.guild_managed_nicknames.pending_applied_nickname IS
  'Nickname BrawlHub intended to apply in the pending cycle.';
COMMENT ON COLUMN public.guild_managed_nicknames.pending_previous_nickname IS
  'Nickname observed immediately before the pending cycle, used only if Discord confirmation is recovered.';

-- Deterministic keyset page of every active managed nickname in one guild.
CREATE OR REPLACE FUNCTION public.guild_managed_nickname_page(
  p_guild_id text,
  p_limit integer DEFAULT 1000,
  p_after_discord_user_id text DEFAULT NULL
)
RETURNS TABLE (
  guild_id text,
  discord_user_id text,
  applied_nickname text,
  previous_nickname text,
  source text,
  source_id text,
  player_id uuid,
  player_tag text,
  player_name text,
  prefix text,
  applied_at timestamptz,
  updated_at timestamptz,
  last_seen_at timestamptz,
  released_at timestamptz,
  cycle_id uuid,
  confirmed_at timestamptz,
  pending_cycle_id uuid,
  pending_applied_nickname text,
  pending_previous_nickname text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.guild_id, n.discord_user_id, n.applied_nickname, n.previous_nickname,
         n.source, n.source_id, n.player_id, n.player_tag, n.player_name, n.prefix,
         n.applied_at, n.updated_at, n.last_seen_at, n.released_at,
         n.cycle_id, n.confirmed_at, n.pending_cycle_id,
         n.pending_applied_nickname, n.pending_previous_nickname
    FROM public.guild_managed_nicknames n
   WHERE NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NOT NULL
     AND n.guild_id = btrim(p_guild_id)
     AND n.released_at IS NULL
     AND (p_after_discord_user_id IS NULL OR n.discord_user_id > p_after_discord_user_id)
   ORDER BY n.discord_user_id ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.guild_managed_nickname_page(text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guild_managed_nickname_page(text, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guild_managed_nickname_page(text, integer, text) TO service_role;

COMMENT ON FUNCTION public.guild_managed_nickname_page(text, integer, text) IS
  'Return one deterministic keyset page of active guild-scoped managed nicknames; blank guild scope returns no rows.';

-- Persist the intent and prior nickname BEFORE calling Discord. This row is not
-- a confirmed application and never reactivates a released nickname by itself.
CREATE OR REPLACE FUNCTION public.managed_nickname_intent(
  p_guild_id text,
  p_discord_user_id text,
  p_cycle_id uuid,
  p_applied_nickname text,
  p_previous_nickname text,
  p_source text,
  p_source_id text,
  p_player_id uuid,
  p_player_tag text,
  p_player_name text,
  p_prefix text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_discord_user_id, '')), '') IS NULL
     OR p_cycle_id IS NULL THEN
    RAISE EXCEPTION 'Nickname intent requires guild, user and cycle' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.guild_managed_nicknames AS n (
    guild_id, discord_user_id, applied_nickname, previous_nickname,
    cycle_id, confirmed_at, pending_cycle_id, pending_applied_nickname,
    pending_previous_nickname, source, source_id, player_id, player_tag,
    player_name, prefix, applied_at, updated_at, last_seen_at
  )
  VALUES (
    btrim(p_guild_id), btrim(p_discord_user_id), p_applied_nickname, p_previous_nickname,
    p_cycle_id, NULL, p_cycle_id, p_applied_nickname, p_previous_nickname,
    p_source, p_source_id, p_player_id, p_player_tag, p_player_name, p_prefix,
    now(), now(), now()
  )
  ON CONFLICT (guild_id, discord_user_id) DO UPDATE
     SET pending_cycle_id = EXCLUDED.pending_cycle_id,
         pending_applied_nickname = EXCLUDED.pending_applied_nickname,
         pending_previous_nickname = EXCLUDED.pending_previous_nickname,
         source = EXCLUDED.source,
         source_id = EXCLUDED.source_id,
         player_id = EXCLUDED.player_id,
         player_tag = EXCLUDED.player_tag,
         player_name = EXCLUDED.player_name,
         prefix = EXCLUDED.prefix,
         updated_at = now(),
         last_seen_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.managed_nickname_intent(text, text, uuid, text, text, text, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.managed_nickname_intent(text, text, uuid, text, text, text, text, uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.managed_nickname_intent(text, text, uuid, text, text, text, text, uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.managed_nickname_intent(text, text, uuid, text, text, text, text, uuid, text, text, text) IS
  'Persist a recoverable nickname-write intent before Discord; never clears released_at or confirms a cycle.';

-- Confirm the pending write, or refresh metadata for an already confirmed
-- cycle. Returns false when the row was released or a newer cycle superseded it.
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
         applied_nickname = CASE
                              WHEN n.pending_cycle_id = p_cycle_id
                                THEN COALESCE(n.pending_applied_nickname, n.applied_nickname)
                              ELSE n.applied_nickname
                            END,
         previous_nickname = CASE
                               WHEN n.pending_cycle_id = p_cycle_id
                                 THEN COALESCE(n.pending_previous_nickname, n.previous_nickname)
                               ELSE n.previous_nickname
                             END,
         pending_cycle_id = NULL,
         pending_applied_nickname = NULL,
         pending_previous_nickname = NULL,
         source = p_source,
         source_id = p_source_id,
         player_id = p_player_id,
         player_tag = p_player_tag,
         player_name = p_player_name,
         prefix = p_prefix,
         updated_at = now(),
         last_seen_at = now()
   WHERE n.guild_id = btrim(p_guild_id)
     AND n.discord_user_id = btrim(p_discord_user_id)
     AND n.released_at IS NULL
     AND (
       n.pending_cycle_id = p_cycle_id
       OR (n.cycle_id = p_cycle_id AND n.pending_cycle_id IS NULL)
     )
   RETURNING n.discord_user_id INTO v_updated;

  RETURN v_updated IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.managed_nickname_mark_applied(text, text, uuid, text, text, uuid, text, text, text) IS
  'Confirm an applied nickname write for the exact cycle, or refresh an already confirmed active cycle; returns false if superseded.';

CREATE OR REPLACE FUNCTION public.managed_nickname_release(
  p_guild_id text,
  p_discord_user_id text,
  p_cycle_id uuid
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
    RAISE EXCEPTION 'Nickname release requires guild, user and cycle' USING ERRCODE = '22023';
  END IF;

  UPDATE public.guild_managed_nicknames n
     SET released_at = now(),
         updated_at = now(),
         pending_cycle_id = NULL,
         pending_applied_nickname = NULL,
         pending_previous_nickname = NULL
   WHERE n.guild_id = btrim(p_guild_id)
     AND n.discord_user_id = btrim(p_discord_user_id)
     AND n.released_at IS NULL
     AND (n.cycle_id = p_cycle_id OR n.pending_cycle_id = p_cycle_id)
   RETURNING n.discord_user_id INTO v_updated;

  RETURN v_updated IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.managed_nickname_release(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.managed_nickname_release(text, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.managed_nickname_release(text, text, uuid) TO service_role;

COMMENT ON FUNCTION public.managed_nickname_release(text, text, uuid) IS
  'Release only the exact current or pending nickname cycle for one guild member; returns false when already released or superseded.';

NOTIFY pgrst, 'reload schema';
