-- Supabase Preview can reuse a database where the Phase 3 audit policy was
-- already created while its migration was not recorded as applied. Removing the
-- stale policy here lets 0007 recreate it idempotently on a fresh or replayed
-- preview database. The net production schema is unchanged.

DROP POLICY IF EXISTS audit_logs_select_owner ON public.audit_logs;
