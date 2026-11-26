-- Track the server nicknames BrawlHub actually applied so cleanup can restore a
-- member's previous nickname without guessing. The ledger is service-role only:
-- users must not be able to rewrite the "previous" value and steer a restore.

SET search_path = public;

CREATE TABLE IF NOT EXISTS public.guild_managed_nicknames (
  guild_id text NOT NULL,
  discord_user_id text NOT NULL,
  applied_nickname text NOT NULL CHECK (char_length(applied_nickname) BETWEEN 1 AND 32),
  previous_nickname text NULL CHECK (
    previous_nickname IS NULL OR char_length(previous_nickname) BETWEEN 1 AND 32
  ),
  source text NOT NULL CHECK (btrim(source) <> ''),
  source_id text NULL,
  player_id uuid NULL,
  player_tag text NULL,
  player_name text NULL,
  prefix text NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  PRIMARY KEY (guild_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_managed_nicknames_active
  ON public.guild_managed_nicknames (guild_id, discord_user_id)
  WHERE released_at IS NULL;

ALTER TABLE public.guild_managed_nicknames ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_managed_nicknames FROM anon, authenticated;
GRANT ALL ON TABLE public.guild_managed_nicknames TO service_role;

COMMENT ON TABLE public.guild_managed_nicknames IS
  'Guild-scoped ledger of nicknames applied by BrawlHub, including the previous nickname to restore when a verified main is revoked or sync no longer applies.';
COMMENT ON COLUMN public.guild_managed_nicknames.previous_nickname IS
  'The nickname present immediately before the first BrawlHub application; kept unchanged on reapply. NULL means the member had no server nickname.';
COMMENT ON COLUMN public.guild_managed_nicknames.released_at IS
  'Set once BrawlHub no longer manages this nickname; active rows have NULL.';
