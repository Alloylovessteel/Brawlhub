-- Phase 1A: main/alt designation for linked Brawl Stars accounts.
-- Additive only: safe to apply against an existing database with linked accounts.

ALTER TABLE public.player_verifications
  ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;

-- At most one active main account per Discord profile. Alt accounts are simply
-- active links with is_main = false.
CREATE UNIQUE INDEX IF NOT EXISTS uq_player_verifications_one_main_per_profile
  ON public.player_verifications (profile_id)
  WHERE status = 'active' AND is_main;

-- Idempotent backfill: if a profile has active links but no main, promote its
-- earliest verified active link. Profiles that already have a main are untouched.
WITH ranked AS (
  SELECT
    pv.id,
    pv.profile_id,
    row_number() OVER (
      PARTITION BY pv.profile_id
      ORDER BY pv.verified_at ASC, pv.created_at ASC, pv.id ASC
    ) AS rn
  FROM public.player_verifications pv
  WHERE pv.status = 'active'
),
missing_main AS (
  SELECT DISTINCT r.profile_id
  FROM ranked r
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.player_verifications existing
    WHERE existing.profile_id = r.profile_id
      AND existing.status = 'active'
      AND existing.is_main
  )
)
UPDATE public.player_verifications v
  SET is_main = true
FROM ranked r
JOIN missing_main m ON m.profile_id = r.profile_id
WHERE v.id = r.id
  AND r.rn = 1;

COMMENT ON COLUMN public.player_verifications.is_main IS
  'True for the single active main Brawl Stars account of a Discord profile; all other active links are alts.';
