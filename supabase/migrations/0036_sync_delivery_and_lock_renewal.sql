-- Notification delivery state and sync-lock heartbeat.
--
-- A notification claim used to be a single row with no way to tell a delivered
-- message from one interrupted between claim insertion and delivery. Existing
-- rows are legacy delivered claims, so they default to `sent`; new claims start
-- as `pending` and are marked `sent` or `failed` by the sync worker.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'notifications_delivery_status_check'
       AND conrelid = 'public.notifications'::regclass
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_delivery_status_check
      CHECK (delivery_status IN ('pending', 'sent', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_delivery_status
  ON public.notifications (delivery_status, created_at);

-- Extend a lock that is still owned by the same process. A missing/expired
-- lock cannot be renewed, so another worker may safely take over.
CREATE OR REPLACE FUNCTION public.renew_sync_lock(
  p_scope text,
  p_token uuid,
  p_ttl_seconds integer DEFAULT 1800
)
RETURNS uuid
LANGUAGE sql
AS $$
  UPDATE public.sync_locks
     SET locked_at = now(),
         locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 1800), 1))
   WHERE scope = p_scope
     AND locked_by = p_token
     AND (locked_until IS NULL OR locked_until >= now())
  RETURNING locked_by;
$$;

REVOKE ALL ON FUNCTION public.renew_sync_lock(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.renew_sync_lock(text, uuid, integer) TO service_role;
