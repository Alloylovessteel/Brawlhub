-- Add guild scope to audit logs for per-guild isolation of audit views.
-- Existing rows remain globally scoped (guild_id NULL) and are not shown in guild-scoped bot audit commands.

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS guild_id text;

CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_id_created_at
  ON public.audit_logs (guild_id, created_at DESC);

COMMENT ON COLUMN public.audit_logs.guild_id IS
  'Discord guild/server scope for the audited action when applicable; NULL for legacy or non-guild-scoped entries.';
