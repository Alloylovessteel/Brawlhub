-- Guild-scoped sync runs use dynamically generated lock scopes (`guild:<id>`).
-- Migration 0003 only seeded the legacy `all-clubs` scope and implemented the
-- claim as an UPDATE, so a scope with no row could never be acquired. Replace
-- the function with an upsert that creates missing scope rows atomically while
-- preserving the same TTL and single-holder semantics.

UPDATE public.sync_locks
   SET locked_by = NULL,
       locked_at = NULL,
       locked_until = NULL
 WHERE locked_until IS NOT NULL
   AND locked_until < now();

CREATE OR REPLACE FUNCTION public.try_acquire_sync_lock(
  p_scope text,
  p_token uuid,
  p_ttl_seconds integer DEFAULT 1800
)
RETURNS uuid
LANGUAGE sql
AS $$
  INSERT INTO public.sync_locks AS lock_row (scope, locked_by, locked_at, locked_until)
  VALUES (
    p_scope,
    p_token,
    now(),
    now() + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 1800), 1))
  )
  ON CONFLICT (scope) DO UPDATE
     SET locked_by = EXCLUDED.locked_by,
         locked_at = EXCLUDED.locked_at,
         locked_until = EXCLUDED.locked_until
   WHERE lock_row.locked_by IS NULL
      OR lock_row.locked_until IS NULL
      OR lock_row.locked_until < now()
  RETURNING locked_by;
$$;
