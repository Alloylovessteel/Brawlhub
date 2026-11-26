-- A forced sync is a separate attempt, not a rewrite of the previous completed
-- run. The old unique key prevented a second row for the same scope/period, so
-- /sync force had to reuse the completed row; a failed repeat then made the
-- previously published snapshots untrusted. Allow one row per attempt while a
-- normal retry still reuses its own failed/stale row.

ALTER TABLE public.sync_runs
  DROP CONSTRAINT IF EXISTS sync_runs_scope_period_key;

CREATE INDEX IF NOT EXISTS idx_sync_runs_scope_period_started
  ON public.sync_runs (scope, period_start, started_at DESC);

COMMENT ON TABLE public.sync_runs IS
  'Sync attempts by scope and period; forced retries create a new row so a failed attempt never invalidates the last published completed run.';
