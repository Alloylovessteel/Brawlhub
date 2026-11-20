-- Per-guild, auto-refreshing club overview messages.
-- `overview_channel_id` is configured with `/settings set-overview-channel`.
-- `overview_message_id` is maintained by the bot's 30-minute overview poster
-- so subsequent refreshes edit the original message instead of spamming the channel.
ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS overview_channel_id text,
  ADD COLUMN IF NOT EXISTS overview_message_id text;
