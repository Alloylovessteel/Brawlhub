-- A full member-list read can fail while individual member lookups still work.
-- Reconciliation records that outcome as 'partial' so the run is neither
-- reported as fully successful nor treated as a total failure.

ALTER TABLE public.guild_role_sync_runs
  DROP CONSTRAINT IF EXISTS guild_role_sync_runs_status_check;

ALTER TABLE public.guild_role_sync_runs
  ADD CONSTRAINT guild_role_sync_runs_status_check
  CHECK (status IN ('running', 'completed', 'partial', 'failed'));

COMMENT ON COLUMN public.guild_role_sync_runs.status IS
  'Lifecycle of a guild role sync. partial means the member list was unavailable and only individually confirmed members were reconciled.';
