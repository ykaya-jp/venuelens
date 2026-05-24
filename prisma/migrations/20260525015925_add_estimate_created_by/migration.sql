-- Migration: add Estimate.created_by for author tracking
--
-- Estimate has lived as a project-shared row since launch — `userId` was
-- intentionally omitted so both members can edit / version the same
-- estimate. The 2026-05-24 audit (P2-29) flagged that this hid "誰が
-- 入れた見積か" from the UI, leaving couples unable to tell their own
-- entry from their partner's at a glance.
--
-- Compromise: keep the row project-shared (so both can edit / re-version
-- without a write-conflict UX), but track who CREATED each row. The
-- column is nullable so existing rows continue to display without a
-- backfill — UI treats null as "誰の入力か不明" (legacy / system).
--
-- ON DELETE SET NULL — if the original author leaves the project (very
-- rare; deleting a User cascades through ProjectMember), the estimate
-- survives without the author label. We prefer surviving data over
-- surviving authorship.

ALTER TABLE "estimates"
  ADD COLUMN "created_by" UUID;

ALTER TABLE "estimates"
  ADD CONSTRAINT "estimates_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index supports the rare "show me all estimates I created" filter
-- which the audit follow-up RFC may surface in the compare UI.
CREATE INDEX "estimates_created_by_idx"
  ON "estimates"("created_by");
