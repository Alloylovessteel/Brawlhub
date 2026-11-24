-- Live poll metrics distinguish collection, storage and delivery.
--
-- One official battle-log collection is shared by every guild subscribing to a
-- player, so the old new_battles column could mean either "candidates emitted
-- by the collector" or "messages posted to a channel". Keep that column as a
-- legacy alias of stored_battles and record the three counts separately.
-- Additive only: migrations 0001-0025 are untouched and no existing column is
-- dropped, renamed or repurposed.

ALTER TABLE public.live_battle_polls
  ADD COLUMN IF NOT EXISTS collected_candidates integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stored_battles integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_messages integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.live_battle_polls.collected_candidates IS
  'Valid official battle candidates emitted by the shared collector for this poll.';
COMMENT ON COLUMN public.live_battle_polls.stored_battles IS
  'Rows actually inserted into player_battles by the shared collector; new_battles mirrors this value.';
COMMENT ON COLUMN public.live_battle_polls.delivered_messages IS
  'Discord messages successfully posted and recorded for this subscription in this poll.';
COMMENT ON COLUMN public.live_battle_polls.new_battles IS
  'Legacy alias of stored_battles, retained for existing dashboards and callers.';
