-- Migration: force-dedupe venue_checklist_answers using ctid
--
-- The 20260525210010 migration's `a.id < b.id` DELETE did not (or did
-- not fully) clean up the duplicate (project_checklist_id, venue_id,
-- user_id) rows — the next production save (2026-05-25 21:15 JST) hit
-- the same P2002 violation. cuid ordering at the text level can be
-- non-trivial; switch to Postgres's `ctid` physical row identifier
-- combined with `ROW_NUMBER() OVER (PARTITION BY ...)` to guarantee
-- exactly one row per logical key remains.
--
-- Selection rule: per (pc, venue, user) keep the row with the latest
-- `updated_at` (NULL goes last) — that's the row whose numericScore
-- is the most recent save and therefore the most plausible "what the
-- couple actually meant". Ties on updated_at fall back to lexicographic
-- `id` (newer cuid wins).
--
-- This migration is idempotent — a re-run on a clean DB deletes
-- nothing because every (pc, venue, user) tuple has exactly 1 row.

DELETE FROM "venue_checklist_answers"
WHERE ctid IN (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      ROW_NUMBER() OVER (
        PARTITION BY project_checklist_id, venue_id, user_id
        ORDER BY updated_at DESC NULLS LAST, id DESC
      ) AS rn
    FROM "venue_checklist_answers"
  ) ranked
  WHERE ranked.rn > 1
);

-- Verify the unique constraint is in place. Cheap if already ADD'd.
ALTER TABLE "venue_checklist_answers"
  DROP CONSTRAINT IF EXISTS "venue_checklist_answers_project_checklist_id_venue_id_user_id_key";

ALTER TABLE "venue_checklist_answers"
  ADD CONSTRAINT "venue_checklist_answers_project_checklist_id_venue_id_user_id_key"
  UNIQUE ("project_checklist_id", "venue_id", "user_id");
