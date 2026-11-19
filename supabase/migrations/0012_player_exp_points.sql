-- Add missing experience points column for richer player profiles.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS exp_points integer;

COMMENT ON COLUMN public.players.exp_points IS
  'Experience points from the official Brawl Stars player profile.';
