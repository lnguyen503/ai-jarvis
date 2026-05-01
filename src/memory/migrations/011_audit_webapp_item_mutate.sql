-- Migration 011: webapp.item_mutate + webapp.stale_edit audit categories (v1.14.2)
--
-- No new columns or tables are needed. The audit_log table already supports
-- arbitrary category strings via its `category TEXT NOT NULL` column.
--
-- The existing index idx_audit_category_actor_ts (migration 010) covers
-- (category, actor_user_id, ts DESC) — this is sufficient for:
--   SELECT ... WHERE category = 'webapp.item_mutate' AND actor_user_id = ? AND ts >= ?
-- Both new categories benefit from this index with no additional DDL.
--
-- This migration is a marker migration: it documents the new categories and
-- adds an idempotent supplementary index scoped to (category, ts) for
-- operator queries that aggregate across all actors (e.g., audit dashboards).

CREATE INDEX IF NOT EXISTS idx_audit_category_ts
  ON audit_log(category, ts DESC);
