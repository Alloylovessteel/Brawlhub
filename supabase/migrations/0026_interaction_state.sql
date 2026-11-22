-- Persistent interaction and verification state for the bot. Additive only:
-- these tables are new and no existing table or column is changed. Every row
-- is service-role only; anon/authenticated have no privileges at all.

CREATE TABLE IF NOT EXISTS public.guild_interaction_sessions (
  guild_id text NOT NULL,
  command text NOT NULL,
  kind text NOT NULL,
  actor_discord_user_id text NOT NULL,
  nonce text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, command, actor_discord_user_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_guild_interaction_sessions_command_expiry
  ON public.guild_interaction_sessions (command, expires_at);

CREATE INDEX IF NOT EXISTS idx_guild_interaction_sessions_guild_actor
  ON public.guild_interaction_sessions (guild_id, actor_discord_user_id);

ALTER TABLE public.guild_interaction_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_interaction_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_interaction_sessions TO service_role;

CREATE TABLE IF NOT EXISTS public.guild_interaction_replays (
  guild_id text NOT NULL,
  actor_discord_user_id text NOT NULL,
  nonce text NOT NULL,
  action_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, actor_discord_user_id, nonce, action_key)
);

CREATE INDEX IF NOT EXISTS idx_guild_interaction_replays_expiry
  ON public.guild_interaction_replays (expires_at);

ALTER TABLE public.guild_interaction_replays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_interaction_replays FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_interaction_replays TO service_role;

CREATE TABLE IF NOT EXISTS public.verification_challenges (
  guild_id text NOT NULL,
  discord_user_id text NOT NULL,
  target_player_id uuid NOT NULL,
  target_tag text NOT NULL,
  challenge_icon_id integer NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id, target_tag)
);

-- A Discord user may have at most one active challenge per guild. Re-running
-- `start` is expected to resume it rather than rotate the required icon.
CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_challenges_one_active
  ON public.verification_challenges (guild_id, discord_user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_verification_challenges_expiry
  ON public.verification_challenges (expires_at);

ALTER TABLE public.verification_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.verification_challenges FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_challenges TO service_role;

CREATE TABLE IF NOT EXISTS public.guild_runtime_leases (
  lease_kind text NOT NULL,
  scope text NOT NULL,
  owner_id text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz NULL,
  PRIMARY KEY (lease_kind, scope)
);

CREATE INDEX IF NOT EXISTS idx_guild_runtime_leases_expiry
  ON public.guild_runtime_leases (expires_at);

ALTER TABLE public.guild_runtime_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_runtime_leases FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_runtime_leases TO service_role;
