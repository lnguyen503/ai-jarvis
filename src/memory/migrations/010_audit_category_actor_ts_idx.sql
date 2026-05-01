-- v1.11.0 R6 — index supporting /organize reconcile (organize.inconsistency queries)
-- and /organize nag cost (organize.nudge queries). Also benefits future category-scoped
-- audit aggregations.
CREATE INDEX IF NOT EXISTS idx_audit_category_actor_ts
  ON audit_log(category, actor_user_id, ts DESC);
