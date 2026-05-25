-- Migration: purge ALL legacy unique surfaces on venue_checklist_answers
--
-- After PR #73 + #74's dedupe migrations, production still raised P2002
-- on the FIRST save by a partner against a venue the other had already
-- graded ("妻が評価してる式場で 1 発目から失敗、妻が評価してない式場では成功" —
-- user report 2026-05-25 21:15 JST).
--
-- That signature is impossible under the new `@@unique(pc, venue, user)`
-- constraint alone: two rows with different user_id can co-exist, so a
-- fresh INSERT for the partner can never collide with the spouse's row.
-- The remaining hypothesis is that the OLD per-couple unique constraint
-- `(project_checklist_id, venue_id)` is STILL enforced under a name the
-- 20260516010000 swap-step didn't reach with its `DROP IF EXISTS` calls
-- (Prisma's auto-naming changed between schema versions, or a hand-rolled
-- index from a much earlier migration survived).
--
-- Strategy: dynamically inspect every constraint AND every unique index
-- attached to the table, drop anything that enforces (pc, venue) without
-- user_id, then re-assert the per-user unique. Also emits RAISE NOTICE
-- diagnostics so the Vercel build log records the before/after state
-- — that's our remote eye into the production schema.

DO $$
DECLARE
  rec RECORD;
  diag_count INT;
BEGIN
  -- ── BEFORE diagnostics ─────────────────────────────────────────────

  RAISE NOTICE '[diag] === venue_checklist_answers constraints BEFORE ===';
  FOR rec IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'venue_checklist_answers'::regclass
    ORDER BY conname
  LOOP
    RAISE NOTICE '[diag]   constraint: % :: %', rec.conname, rec.def;
  END LOOP;

  RAISE NOTICE '[diag] === venue_checklist_answers indexes BEFORE ===';
  FOR rec IN
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'venue_checklist_answers'
    ORDER BY indexname
  LOOP
    RAISE NOTICE '[diag]   index: % :: %', rec.indexname, rec.indexdef;
  END LOOP;

  -- ── Duplicates check ──────────────────────────────────────────────

  SELECT COUNT(*) INTO diag_count FROM (
    SELECT 1 FROM venue_checklist_answers
    GROUP BY project_checklist_id, venue_id, user_id
    HAVING COUNT(*) > 1
  ) d;
  RAISE NOTICE '[diag] duplicates by (pc, venue, user): % groups', diag_count;

  SELECT COUNT(*) INTO diag_count FROM (
    SELECT 1 FROM venue_checklist_answers
    GROUP BY project_checklist_id, venue_id
    HAVING COUNT(*) > 1
  ) d;
  RAISE NOTICE '[diag] rows sharing (pc, venue) (= 2 users on same item, expected when partner present): % groups', diag_count;

  -- ── Drop ALL unique-related constraints on this table ─────────────
  -- We rebuild the only one we want at the end.

  FOR rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'venue_checklist_answers'::regclass
      AND contype = 'u'  -- UNIQUE constraint type
  LOOP
    EXECUTE format('ALTER TABLE "venue_checklist_answers" DROP CONSTRAINT IF EXISTS %I', rec.conname);
    RAISE NOTICE '[diag] dropped UNIQUE constraint: %', rec.conname;
  END LOOP;

  -- Drop ALL non-PK unique indexes too (some Postgres environments store
  -- the unique enforcement as a bare index without a matching constraint
  -- row — covers the case where Prisma's old @@unique created an INDEX
  -- and not a CONSTRAINT).

  FOR rec IN
    SELECT i.indexname
    FROM pg_indexes i
    JOIN pg_index x ON x.indexrelid = (
      SELECT c.oid FROM pg_class c
      WHERE c.relname = i.indexname AND c.relkind = 'i'
    )
    WHERE i.schemaname = 'public'
      AND i.tablename = 'venue_checklist_answers'
      AND x.indisunique
      AND NOT x.indisprimary  -- keep the PK index
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', rec.indexname);
    RAISE NOTICE '[diag] dropped UNIQUE index: %', rec.indexname;
  END LOOP;

  -- ── Dedupe one more time using ctid (safety net) ──────────────────

  WITH del AS (
    DELETE FROM venue_checklist_answers
    WHERE ctid IN (
      SELECT ctid FROM (
        SELECT ctid, ROW_NUMBER() OVER (
          PARTITION BY project_checklist_id, venue_id, user_id
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS rn
        FROM venue_checklist_answers
      ) ranked
      WHERE ranked.rn > 1
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO diag_count FROM del;
  RAISE NOTICE '[diag] safety-net DELETE (pc, venue, user) duplicates removed: %', diag_count;

  -- ── Re-create THE one unique we actually want ─────────────────────

  ALTER TABLE "venue_checklist_answers"
    ADD CONSTRAINT "venue_checklist_answers_project_checklist_id_venue_id_user_id_key"
    UNIQUE ("project_checklist_id", "venue_id", "user_id");

  RAISE NOTICE '[diag] (re-)added UNIQUE (project_checklist_id, venue_id, user_id)';

  -- ── AFTER diagnostics ─────────────────────────────────────────────

  RAISE NOTICE '[diag] === venue_checklist_answers constraints AFTER ===';
  FOR rec IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'venue_checklist_answers'::regclass
    ORDER BY conname
  LOOP
    RAISE NOTICE '[diag]   constraint: % :: %', rec.conname, rec.def;
  END LOOP;
END $$;
