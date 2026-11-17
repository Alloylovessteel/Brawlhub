-- Preserve the error from a failed attempt even after the same run is retried
-- and later completes. `error` describes the current status; `last_error`
-- keeps the most recent failure for auditability.
ALTER TABLE public.sync_runs
  ADD COLUMN IF NOT EXISTS last_error text;
