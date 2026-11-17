ALTER TABLE public.sync_runs
  ADD COLUMN IF NOT EXISTS affected_club_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS club_tags text[] NOT NULL DEFAULT '{}';
