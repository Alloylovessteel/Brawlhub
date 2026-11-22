-- Additive: declarative per-guild auto-role configuration and a managed-role ledger.
-- All role automation data is strictly guild-scoped. Only the trusted service
-- role can read or write these tables; no anon/authenticated policies exist.
-- Applied migrations 0001-0025 remain untouched.

-- ---------------------------------------------------------------------------
-- Declarative configuration: one row per guild, role kind and tier key.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.guild_auto_role_configs (
  guild_id text NOT NULL,
  role_kind text NOT NULL CHECK (role_kind IN (
    'verify', 'trophy', 'solo_win', 'duo_win', 'vs_win',
    'brawler', 'level', 'ranked', 'club', 'fame'
  )),
  tier_key text NOT NULL,
  discord_role_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, role_kind, tier_key)
);

CREATE INDEX IF NOT EXISTS idx_guild_auto_role_configs_guild_kind
  ON public.guild_auto_role_configs (guild_id, role_kind);
CREATE INDEX IF NOT EXISTS idx_guild_auto_role_configs_guild_role
  ON public.guild_auto_role_configs (guild_id, discord_role_id);

DROP TRIGGER IF EXISTS trg_guild_auto_role_configs_updated_at
  ON public.guild_auto_role_configs;
CREATE TRIGGER trg_guild_auto_role_configs_updated_at
  BEFORE UPDATE ON public.guild_auto_role_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.guild_auto_role_configs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_auto_role_configs FROM anon, authenticated;
GRANT ALL ON TABLE public.guild_auto_role_configs TO service_role;

COMMENT ON TABLE public.guild_auto_role_configs IS
  'Guild-scoped declarative auto-role rules. Tier keys are official-derived values only (for example ranked tier, trophy threshold or club rank).';
COMMENT ON COLUMN public.guild_auto_role_configs.role_kind IS
  'One of the ten supported auto-role kinds configured under /auto setup.';
COMMENT ON COLUMN public.guild_auto_role_configs.tier_key IS
  'Tier key from the default map for the kind; never a Discord username or guessed value.';

-- ---------------------------------------------------------------------------
-- Ledger: the complete set of Discord roles this bot may mutate in a guild.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.guild_managed_roles (
  guild_id text NOT NULL,
  discord_role_id text NOT NULL,
  role_kind text NOT NULL CHECK (role_kind IN (
    'verify', 'trophy', 'solo_win', 'duo_win', 'vs_win',
    'brawler', 'level', 'ranked', 'club', 'fame'
  )),
  created_by_profile_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_role_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_managed_roles_guild_kind
  ON public.guild_managed_roles (guild_id, role_kind);

ALTER TABLE public.guild_managed_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_managed_roles FROM anon, authenticated;
GRANT ALL ON TABLE public.guild_managed_roles TO service_role;

COMMENT ON TABLE public.guild_managed_roles IS
  'Ledger of Discord roles the bot is allowed to add or remove in each guild. Reconciliation never touches roles outside this ledger.';

-- ---------------------------------------------------------------------------
-- Assignment history: auditable active/revoked role grants per guild member.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.guild_role_assignments (
  guild_id text NOT NULL,
  discord_user_id text NOT NULL,
  profile_id uuid NULL,
  player_id uuid NULL,
  discord_role_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN (
    'verify', 'trophy', 'solo_win', 'duo_win', 'vs_win',
    'brawler', 'level', 'ranked', 'club', 'fame'
  )),
  source_id text NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id, discord_role_id, assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_guild_role_assignments_active
  ON public.guild_role_assignments (guild_id, discord_user_id, discord_role_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guild_role_assignments_guild_user
  ON public.guild_role_assignments (guild_id, discord_user_id);
CREATE INDEX IF NOT EXISTS idx_guild_role_assignments_guild_active
  ON public.guild_role_assignments (guild_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_guild_role_assignments_guild_role
  ON public.guild_role_assignments (guild_id, discord_role_id);

ALTER TABLE public.guild_role_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_role_assignments FROM anon, authenticated;
GRANT ALL ON TABLE public.guild_role_assignments TO service_role;

COMMENT ON TABLE public.guild_role_assignments IS
  'Guild-scoped history of bot-managed role grants. source_kind/source_id point at the declarative rule that produced the assignment.';
COMMENT ON COLUMN public.guild_role_assignments.revoked_at IS
  'Set when reconciliation removes the role; inactive rows are kept for audit history.';

-- ---------------------------------------------------------------------------
-- Sync run bookkeeping for full guild reconciliations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.guild_role_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  roles_added integer NOT NULL DEFAULT 0,
  roles_removed integer NOT NULL DEFAULT 0,
  roles_unchanged integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  last_error text NULL
);

CREATE INDEX IF NOT EXISTS idx_guild_role_sync_runs_guild_started
  ON public.guild_role_sync_runs (guild_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_guild_role_sync_runs_status
  ON public.guild_role_sync_runs (status);

ALTER TABLE public.guild_role_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guild_role_sync_runs FROM anon, authenticated;
GRANT ALL ON TABLE public.guild_role_sync_runs TO service_role;

COMMENT ON TABLE public.guild_role_sync_runs IS
  'One row per guild role reconciliation, used for counts and failure diagnostics.';
