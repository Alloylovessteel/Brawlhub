-- Opt-in live battle tracking and stored chart/image cache. Additive only:
-- migrations 0001-0025 (and the parallel 0026-0028 migrations) are untouched.
-- Every new table is guild-scoped; the service role is the only writer.

CREATE TABLE IF NOT EXISTS public.guild_live_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  discord_user_id text NOT NULL,
  profile_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_battle_seen_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (guild_id, channel_id, discord_user_id, player_id),
  CONSTRAINT guild_live_subscriptions_id_key UNIQUE (id),
  CONSTRAINT guild_live_subscriptions_guild_id_id_key UNIQUE (guild_id, id)
);

CREATE INDEX IF NOT EXISTS idx_guild_live_subscriptions_active_expires
  ON public.guild_live_subscriptions (active, expires_at);
CREATE INDEX IF NOT EXISTS idx_guild_live_subscriptions_player
  ON public.guild_live_subscriptions (player_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_guild_live_subscriptions_guild_channel
  ON public.guild_live_subscriptions (guild_id, channel_id);

ALTER TABLE public.guild_live_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_live_subscriptions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_live_subscriptions TO service_role;

CREATE TABLE IF NOT EXISTS public.live_battle_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  poll_started_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  last_battle_at_before timestamptz NULL,
  new_battles integer NOT NULL DEFAULT 0,
  last_error text NULL
);

CREATE INDEX IF NOT EXISTS idx_live_battle_polls_guild_started
  ON public.live_battle_polls (guild_id, poll_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_battle_polls_status
  ON public.live_battle_polls (status, poll_started_at DESC);

ALTER TABLE public.live_battle_polls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.live_battle_polls FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_battle_polls TO service_role;

CREATE TABLE IF NOT EXISTS public.live_battle_deliveries (
  guild_id text NOT NULL,
  subscription_id uuid NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  battle_key text NOT NULL,
  discord_message_id text NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, subscription_id, player_id, battle_key),
  CONSTRAINT live_battle_deliveries_subscription_fkey
    FOREIGN KEY (guild_id, subscription_id)
    REFERENCES public.guild_live_subscriptions (guild_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_live_battle_deliveries_player_key
  ON public.live_battle_deliveries (player_id, battle_key);

ALTER TABLE public.live_battle_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.live_battle_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_battle_deliveries TO service_role;

CREATE TABLE IF NOT EXISTS public.generated_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  kind text NOT NULL,
  subject_tag text NULL,
  club_id uuid NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  options_hash text NOT NULL,
  source_fingerprint text NOT NULL,
  render_version text NOT NULL,
  png_base64 text NOT NULL,
  content_type text NOT NULL DEFAULT 'image/png',
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL
);

-- Expression unique key: NULL subject/club values are treated as empty strings,
-- so every combination has one cache row. PostgREST lookups still filter by the
-- ordinary columns, which keeps the read path simple and guild-scoped.
CREATE UNIQUE INDEX IF NOT EXISTS generated_images_cache_key_unique
  ON public.generated_images (
    guild_id,
    kind,
    coalesce(subject_tag, ''),
    coalesce(club_id::text, ''),
    options_hash,
    source_fingerprint,
    render_version
  );

CREATE INDEX IF NOT EXISTS idx_generated_images_guild_kind_subject
  ON public.generated_images (guild_id, kind, subject_tag);
CREATE INDEX IF NOT EXISTS idx_generated_images_guild_kind_club
  ON public.generated_images (guild_id, kind, club_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_expires_at
  ON public.generated_images (expires_at);

ALTER TABLE public.generated_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.generated_images FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generated_images TO service_role;

COMMENT ON TABLE public.guild_live_subscriptions IS
  'Guild-scoped, opt-in live battle subscriptions. Max lifetime 3h; idle cutoff 60m.';
COMMENT ON TABLE public.live_battle_polls IS
  'Per-guild/player audit of live battle-log polls (official API is the truth source).';
COMMENT ON TABLE public.live_battle_deliveries IS
  'Guild-scoped delivery ledger; prevents duplicate battle messages to a channel.';
COMMENT ON TABLE public.generated_images IS
  'Guild-scoped PNG cache for stored-data charts and images.';
