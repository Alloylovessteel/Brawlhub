-- Blacklist listing must filter before limiting. The previous bot path read at
-- most 500 active rows and several capped identity tables, then searched the
-- truncated result. This service-role-only RPC rechecks the 0009 actor rules,
-- joins all searchable identities in the database, and returns one ordered page
-- plus the total count of the full filtered set.

CREATE OR REPLACE FUNCTION public.moderation_blacklist_list(
  p_actor_profile_id uuid,
  p_actor_discord_id text,
  p_search text,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_discord_id text := nullif(btrim(p_actor_discord_id), '');
  v_profile_discord_id text;
  v_search text := nullif(btrim(p_search), '');
  v_pattern text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_total bigint := 0;
  v_entries jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_profile_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_actor');
  END IF;

  SELECT discord_user_id INTO v_profile_discord_id
    FROM public.profiles
   WHERE id = p_actor_profile_id;

  IF NOT FOUND OR v_actor_discord_id IS NULL OR v_actor_discord_id <> v_profile_discord_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_actor');
  END IF;

  IF NOT public.can_manage_blacklists(p_actor_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  IF v_search IS NOT NULL THEN
    v_pattern := '%' || v_search || '%';
  END IF;

  WITH filtered AS (
    SELECT DISTINCT ON (b.id)
           b.id,
           b.player_id,
           p.tag AS player_tag,
           p.name AS player_name,
           b.reason,
           b.created_by,
           creator.discord_user_id AS creator_discord_id,
           b.created_at,
           b.expires_at,
           target.discord_user_id AS target_discord_id,
           target_du.username AS target_username
      FROM public.blacklists b
      LEFT JOIN public.players p
        ON p.id = b.player_id
      LEFT JOIN public.profiles creator
        ON creator.id = b.created_by
      LEFT JOIN public.discord_users creator_du
        ON creator_du.discord_user_id = creator.discord_user_id
      LEFT JOIN public.player_verifications pv
        ON pv.player_id = b.player_id
       AND pv.status = 'active'
      LEFT JOIN public.profiles target
        ON target.id = pv.profile_id
      LEFT JOIN public.discord_users target_du
        ON target_du.discord_user_id = target.discord_user_id
     WHERE b.status = 'active'
       AND (
         v_search IS NULL
         OR p.tag ILIKE v_pattern
         OR p.name ILIKE v_pattern
         OR b.reason ILIKE v_pattern
         OR creator.discord_user_id ILIKE v_pattern
         OR creator_du.username ILIKE v_pattern
         OR target.discord_user_id ILIKE v_pattern
         OR target_du.username ILIKE v_pattern
       )
     ORDER BY b.id, pv.verified_at DESC NULLS LAST, pv.created_at DESC, pv.id DESC
  ), paged AS (
    SELECT *
      FROM filtered
     ORDER BY created_at DESC, id DESC
     LIMIT v_limit OFFSET v_offset
  ), totals AS (
    SELECT count(*)::bigint AS total FROM filtered
  )
  SELECT totals.total,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', paged.id,
               'playerId', paged.player_id,
               'playerTag', paged.player_tag,
               'playerName', paged.player_name,
               'reason', paged.reason,
               'createdByProfileId', paged.created_by,
               'createdByDiscordId', paged.creator_discord_id,
               'createdAt', paged.created_at::text,
               'expiresAt', paged.expires_at::text,
               'removedAt', NULL
             )
             ORDER BY paged.created_at DESC, paged.id DESC
           ) FILTER (WHERE paged.id IS NOT NULL),
           '[]'::jsonb
         )
    INTO v_total, v_entries
    FROM totals
    LEFT JOIN paged ON true
   GROUP BY totals.total;

  RETURN jsonb_build_object('ok', true, 'entries', v_entries, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.moderation_blacklist_list(uuid, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moderation_blacklist_list(uuid, text, text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderation_blacklist_list(uuid, text, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.moderation_blacklist_list(uuid, text, text, integer, integer) IS
  'Filtered, ordered and counted active blacklist page for authorized global moderators.';
