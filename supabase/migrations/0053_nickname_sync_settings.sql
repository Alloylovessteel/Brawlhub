-- BrawlTools-style verified-player nickname sync:
--   * a per-guild custom prefix (for example "[TAG]") placed before the
--     verified Brawl Stars player name;
--   * an explicit per-guild enable flag so automatic renames are opt-out.
-- Only guild-scoped verified links may feed nicknames; the bot resolves those
-- with listGuildVerifiedLinks() and never infers ownership from names or tags.

ALTER TABLE public.guild_settings
  ADD COLUMN IF NOT EXISTS nickname_prefix text,
  ADD COLUMN IF NOT EXISTS nickname_sync_enabled boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'guild_settings_nickname_prefix_check'
       AND conrelid = 'public.guild_settings'::regclass
  ) THEN
    ALTER TABLE public.guild_settings
      ADD CONSTRAINT guild_settings_nickname_prefix_check
      CHECK (
        nickname_prefix IS NULL
        OR (
          char_length(btrim(nickname_prefix)) BETWEEN 1 AND 16
          AND nickname_prefix !~ '[[:cntrl:]]'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.guild_settings.nickname_prefix IS
  'Custom club-tag prefix prepended to verified player names in Discord nicknames; stored verbatim, including brackets.';
COMMENT ON COLUMN public.guild_settings.nickname_sync_enabled IS
  'Whether BrawlHub automatically syncs verified members'' Discord nicknames in this guild.';
