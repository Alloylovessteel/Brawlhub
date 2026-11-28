-- Operator reconciliation for uncertain live battle claims. Additive only;
-- migrations 0001-0064 are untouched.
--
-- A live delivery now records `claim-delivered:<claimId>:<messageId>` when
-- Discord accepted a message but the final ledger write failed. The bot treats
-- that sentinel as delivered. Stale `claim:<uuid>:sending` rows are exposed here
-- for operator review; they are never auto-reposted because Discord may already
-- have the message.

CREATE OR REPLACE FUNCTION public.live_delivery_claims_page(
  p_guild_id text DEFAULT NULL,
  p_older_than interval DEFAULT interval '2 minutes',
  p_limit integer DEFAULT 100,
  p_after_key text DEFAULT NULL
)
RETURNS TABLE (
  guild_id text,
  subscription_id uuid,
  player_id uuid,
  battle_key text,
  discord_message_id text,
  delivered_at timestamptz,
  channel_id text,
  player_tag text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.guild_id,
         d.subscription_id,
         d.player_id,
         d.battle_key,
         d.discord_message_id,
         d.delivered_at,
         s.channel_id,
         p.tag AS player_tag
    FROM public.live_battle_deliveries d
    JOIN public.guild_live_subscriptions s
      ON s.guild_id = d.guild_id
     AND s.id = d.subscription_id
    JOIN public.players p ON p.id = d.player_id
   WHERE d.discord_message_id LIKE 'claim:%:sending'
     AND d.delivered_at < now() - COALESCE(p_older_than, interval '2 minutes')
     AND (
       NULLIF(btrim(COALESCE(p_guild_id, '')), '') IS NULL
       OR d.guild_id = btrim(p_guild_id)
     )
     AND (
       p_after_key IS NULL
       OR concat(d.guild_id, '|', d.subscription_id::text, '|', d.player_id::text, '|', d.battle_key) > p_after_key
     )
   ORDER BY d.delivered_at ASC, d.guild_id ASC, d.subscription_id ASC, d.player_id ASC, d.battle_key ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.live_delivery_claims_page(text, interval, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.live_delivery_claims_page(text, interval, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_delivery_claims_page(text, interval, integer, text) TO service_role;

COMMENT ON FUNCTION public.live_delivery_claims_page(text, interval, integer, text) IS
  'Return a keyset page of stale uncertain live battle claims for operator review; service role only.';

CREATE OR REPLACE FUNCTION public.resolve_live_delivery_claim(
  p_guild_id text,
  p_subscription_id uuid,
  p_player_id uuid,
  p_battle_key text,
  p_expected_claim_id text,
  p_resolution text,
  p_message_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_resolution NOT IN ('sent', 'release') THEN
    RAISE EXCEPTION 'Unknown live delivery resolution' USING ERRCODE = '22023';
  END IF;
  IF p_resolution = 'sent' AND NULLIF(btrim(COALESCE(p_message_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A resolved live delivery requires a Discord message id' USING ERRCODE = '22023';
  END IF;

  IF p_resolution = 'sent' THEN
    UPDATE public.live_battle_deliveries d
       SET discord_message_id = btrim(p_message_id),
           delivered_at = now()
     WHERE d.guild_id = btrim(p_guild_id)
       AND d.subscription_id = p_subscription_id
       AND d.player_id = p_player_id
       AND d.battle_key = p_battle_key
       AND d.discord_message_id = p_expected_claim_id;
  ELSE
    DELETE FROM public.live_battle_deliveries d
     WHERE d.guild_id = btrim(p_guild_id)
       AND d.subscription_id = p_subscription_id
       AND d.player_id = p_player_id
       AND d.battle_key = p_battle_key
       AND d.discord_message_id = p_expected_claim_id;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_live_delivery_claim(text, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_live_delivery_claim(text, uuid, uuid, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_live_delivery_claim(text, uuid, uuid, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.resolve_live_delivery_claim(text, uuid, uuid, text, text, text, text) IS
  'Resolve one exact stale live claim after operator proof; release only when Discord verification proves no message exists.';

NOTIFY pgrst, 'reload schema';
