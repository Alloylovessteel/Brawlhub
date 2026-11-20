-- Phase 4: per-guild ranked role mappings and verification message bookkeeping.
-- All changes are additive; applied migrations 0001-0021 remain untouched.

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS ranked_role_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verification_channel_id text,
  ADD COLUMN IF NOT EXISTS verification_message_id text;

COMMENT ON COLUMN public.guild_settings.ranked_role_ids IS
  'Map of official Brawl Stars ranked tiers to Discord role IDs for this guild only.';
COMMENT ON COLUMN public.guild_settings.verification_channel_id IS
  'Discord channel where this guild''s verification message was posted.';
COMMENT ON COLUMN public.guild_settings.verification_message_id IS
  'Discord message ID of this guild''s verification message; edited in place on setup.';
