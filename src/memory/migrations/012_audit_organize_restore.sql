-- Migration 012: organize.restore audit category + partial index (v1.14.3 D9)
--
-- Adds a partial index for the new `organize.restore` audit category introduced
-- in v1.14.3 for the chat-side /organize restore <id> command.
--
-- No new columns or tables are needed. The audit_log table already supports
-- arbitrary category strings via its `category TEXT NOT NULL` column.
--
-- The existing indexes from migrations 010 + 011 cover general audit queries:
--   idx_audit_category_actor_ts:  (category, actor_user_id, ts DESC)
--   idx_audit_category_ts:        (category, ts DESC)
--
-- The partial index below is a targeted supplement for forensics queries that
-- filter specifically on category='organize.restore'. Because restore events
-- are low-volume (manual invocation only), a partial index avoids adding
-- maintenance overhead to the high-volume webapp.item_mutate insert path
-- while still keeping same-category range scans O(log n).
--
-- Pattern mirrors migration 011; idempotent via IF NOT EXISTS.
-- Documented per ADR 011-revisions-after-cp1.md §File 10 note.

-- Idempotent supplementary index for operator queries scoped to restore events.
CREATE INDEX IF NOT EXISTS idx_audit_organize_restore
  ON audit_log(category, actor_user_id, ts DESC)
  WHERE category = 'organize.restore';
