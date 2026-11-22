-- Shared official API cache and call metrics. Additive only: no existing table
-- or column is modified. Both tables are service-role only and guild-scoped
-- where a request can be attributed to a Discord guild.

CREATE TABLE IF NOT EXISTS public.official_api_cache (
  provider text NOT NULL DEFAULT 'brawl_stars',
  endpoint text NOT NULL,
  scope_guild_id text NULL,
  tag text NULL,
  params_hash text NOT NULL,
  payload jsonb NULL,
  status integer NULL,
  last_error text NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  etag text NULL,
  PRIMARY KEY (provider, endpoint, scope_guild_id, tag, params_hash)
);

-- Postgres treats NULLs as distinct in a primary key. This coalesce-friendly
-- key keeps one row per logical scope for global (NULL guild/tag) lookups.
CREATE UNIQUE INDEX IF NOT EXISTS official_api_cache_coalesce_key
  ON public.official_api_cache (
    provider,
    endpoint,
    coalesce(scope_guild_id, ''),
    coalesce(tag, ''),
    params_hash
  );

CREATE INDEX IF NOT EXISTS idx_official_api_cache_expires_at
  ON public.official_api_cache (expires_at);

ALTER TABLE public.official_api_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.official_api_cache FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.official_api_cache TO service_role;

CREATE TABLE IF NOT EXISTS public.api_call_metrics (
  guild_id text NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status integer NULL,
  duration_ms integer,
  retry_count integer NOT NULL DEFAULT 0,
  error text NULL
);

CREATE INDEX IF NOT EXISTS idx_api_call_metrics_requested_at
  ON public.api_call_metrics (requested_at);

ALTER TABLE public.api_call_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_call_metrics FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_call_metrics TO service_role;
