-- Battle-log history and derived activity support collected from the official
-- Brawl Stars API. Written by the trusted sync/service role; readable as
-- collected history for authenticated dashboard/bot consumers.

CREATE TABLE public.player_battles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  sync_run_id uuid REFERENCES public.sync_runs(id) ON DELETE SET NULL,
  battle_time timestamptz NOT NULL,
  battle_key text NOT NULL,
  mode text,
  map text,
  battle_type text,
  result text,
  trophy_change integer,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_battles_player_key_unique UNIQUE (player_id, battle_key)
);

CREATE INDEX IF NOT EXISTS idx_player_battles_player_time
  ON public.player_battles (player_id, battle_time DESC);

CREATE INDEX IF NOT EXISTS idx_player_battles_time
  ON public.player_battles (battle_time DESC);

CREATE INDEX IF NOT EXISTS idx_player_battles_sync_run
  ON public.player_battles (sync_run_id);

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS last_battle_at timestamptz;

ALTER TABLE public.player_battles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.player_battles FROM anon, authenticated;
GRANT SELECT ON TABLE public.player_battles TO authenticated;
GRANT ALL ON TABLE public.player_battles TO service_role;

DROP POLICY IF EXISTS player_battles_select_authenticated ON public.player_battles;
CREATE POLICY player_battles_select_authenticated
  ON public.player_battles FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE public.player_battles IS
  'Deduped player battle-log entries collected from the official Brawl Stars API for match/activity metrics.';
COMMENT ON COLUMN public.player_battles.battle_key IS
  'Stable dedupe key derived from battle content; unique per player.';
COMMENT ON COLUMN public.players.last_battle_at IS
  'Timestamp of the most recent battle observed in collected battle logs.';
