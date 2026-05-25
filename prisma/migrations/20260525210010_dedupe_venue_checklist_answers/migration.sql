-- Migration: deduplicate venue_checklist_answers + re-assert unique
--
-- Production reproduction 2026-05-25 20:54 JST: a partner trying to
-- enter the very FIRST score on a venue the other had fully graded
-- hit Postgres `23505 duplicate key value violates unique constraint`
-- on the very first save. Not a race — the row collided from the
-- INSERT itself. That points at the table holding duplicate
-- `(project_checklist_id, venue_id, user_id)` tuples that the
-- 20260516010000 migration's swap-the-unique step somehow allowed
-- through (most likely because the prior unique was a partial / named
-- index that `DROP INDEX IF EXISTS` didn't fully clear before the new
-- constraint ADD ran).
--
-- Steps:
--   1. Collapse duplicate rows down to one per logical key, keeping
--      the row with the largest `id` (= cuid lexicographic order ≈
--      latest-created — the right one to preserve because the
--      attendant numericScore is usually the most-recent save).
--   2. Drop and re-create the unique constraint so we're certain the
--      enforced index matches the schema's `@@unique`. No-op when
--      already correct.
--
-- Both steps use `IF EXISTS` / idempotent forms so re-running this
-- migration on a clean DB (= preview / staging) does nothing visible.

-- Step 1: collapse duplicates. The DELETE retains the one row per
-- (pc, venue, user) tuple with the lexicographically-largest id.
DELETE FROM "venue_checklist_answers" a
USING "venue_checklist_answers" b
WHERE a.id < b.id
  AND a.project_checklist_id = b.project_checklist_id
  AND a.venue_id             = b.venue_id
  AND a.user_id              = b.user_id;

-- Step 2: drop + re-create the unique constraint. If 20260516010000
-- did its job, this is a no-op; if it left a stray index behind, this
-- clears it and reasserts the schema-declared constraint.
ALTER TABLE "venue_checklist_answers"
  DROP CONSTRAINT IF EXISTS "venue_checklist_answers_project_checklist_id_venue_id_user_id_key";

-- Also drop any stray un-named unique index that may share the same
-- columns. The constraint above pulls double-duty as its own index,
-- but a leftover from an earlier migration's column-list-only DROP
-- could still be enforcing the unique under a different name.
DROP INDEX IF EXISTS "venue_checklist_answers_project_checklist_id_venue_id_user_id_idx";

ALTER TABLE "venue_checklist_answers"
  ADD CONSTRAINT "venue_checklist_answers_project_checklist_id_venue_id_user_id_key"
  UNIQUE ("project_checklist_id", "venue_id", "user_id");
