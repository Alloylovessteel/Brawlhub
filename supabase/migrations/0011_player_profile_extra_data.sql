-- Store richer player profile fields from the official Brawl Stars API.
-- Additive only: safe to apply independently of unapplied 0006-0009.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS name_color text,
  ADD COLUMN IF NOT EXISTS icon_id integer,
  ADD COLUMN IF NOT EXISTS total_prestige_level integer,
  ADD COLUMN IF NOT EXISTS fame integer,
  ADD COLUMN IF NOT EXISTS fame_tier_name text,
  ADD COLUMN IF NOT EXISTS is_qualified_from_championship_challenge boolean,
  ADD COLUMN IF NOT EXISTS three_vs_three_victories integer,
  ADD COLUMN IF NOT EXISTS duo_victories integer,
  ADD COLUMN IF NOT EXISTS best_robo_rumble_time integer,
  ADD COLUMN IF NOT EXISTS best_time_as_big_brawler integer,
  ADD COLUMN IF NOT EXISTS ranked_season_id integer,
  ADD COLUMN IF NOT EXISTS ranked_rank integer,
  ADD COLUMN IF NOT EXISTS ranked_rank_name text,
  ADD COLUMN IF NOT EXISTS ranked_elo integer,
  ADD COLUMN IF NOT EXISTS highest_season_ranked_rank integer,
  ADD COLUMN IF NOT EXISTS highest_season_ranked_rank_name text,
  ADD COLUMN IF NOT EXISTS highest_season_ranked_elo integer,
  ADD COLUMN IF NOT EXISTS highest_all_time_ranked_rank integer,
  ADD COLUMN IF NOT EXISTS highest_all_time_ranked_rank_name text,
  ADD COLUMN IF NOT EXISTS highest_all_time_ranked_elo integer,
  ADD COLUMN IF NOT EXISTS profile_extra jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.players.profile_extra IS
  'Additional player profile fields from the official API (brawler details, raw extras) for richer display/history.';
