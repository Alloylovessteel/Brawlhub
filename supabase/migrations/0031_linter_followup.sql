-- Follow-up Security Advisor fixes. Additive only.
-- Fixes:
--   * No Primary Key on public.api_call_metrics
--   * RLS Enabled No Policy on service-role-only tables
--   * Unindexed foreign keys across public tables
--
-- "Unused Index" findings are intentionally left alone: removing indexes from a
-- service-role-only schema can hurt performance, and fresh indexes show as
-- unused until queries exercise them.

-- ---------------------------------------------------------------------------
-- 1. Primary key for api_call_metrics.
-- ---------------------------------------------------------------------------

ALTER TABLE public.api_call_metrics
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.api_call_metrics'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.api_call_metrics ADD PRIMARY KEY (id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Explicit deny policies for RLS tables that are service-role-only.
--    No grants exist for anon/authenticated, so this only documents/asserts the
--    existing denial and silences the "RLS enabled but no policy" advisor.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, rel.relname
    FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relkind = 'r'
      AND rel.relrowsecurity = true
      AND NOT EXISTS (
        SELECT 1
        FROM pg_policy p
        WHERE p.polrelid = rel.oid
      )
    ORDER BY rel.relname
  LOOP
    EXECUTE format(
      'CREATE POLICY deny_anon_authenticated_all ON %I.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated '
      'USING (false) WITH CHECK (false)',
      r.nspname,
      r.relname
    );
    RAISE NOTICE 'Added deny policy on %.%', r.nspname, r.relname;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes supporting foreign keys that do not already have one.
--    Only creates an index when no existing valid index already starts with
--    the foreign key columns in the same order.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  v_cols text;
  v_suffix text;
  v_index_name text;
BEGIN
  FOR r IN
    SELECT con.oid, con.conrelid, con.conkey, n.nspname, rel.relname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE con.contype = 'f'
      AND n.nspname = 'public'
      AND rel.relkind = 'r'
    ORDER BY rel.relname, con.oid
  LOOP
    SELECT
      string_agg(quote_ident(a.attname), ', ' ORDER BY fk.ord),
      string_agg(a.attname, '_' ORDER BY fk.ord)
    INTO v_cols, v_suffix
    FROM unnest(r.conkey) WITH ORDINALITY AS fk(attnum, ord)
    JOIN pg_attribute a
      ON a.attrelid = r.conrelid
     AND a.attnum = fk.attnum;

    CONTINUE WHEN v_cols IS NULL;

    v_index_name := left(format('idx_fk_%s_%s_%s', r.relname, v_suffix, r.oid), 63);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index ix
      WHERE ix.indrelid = r.conrelid
        AND ix.indisvalid
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(r.conkey) WITH ORDINALITY AS fk(attnum, ord)
          WHERE ix.indkey[(fk.ord - 1)::int] IS DISTINCT FROM fk.attnum
        )
    ) THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
        v_index_name,
        r.nspname,
        r.relname,
        v_cols
      );
      RAISE NOTICE 'Added FK index % on %.%', v_index_name, r.nspname, r.relname;
    END IF;
  END LOOP;
END $$;
