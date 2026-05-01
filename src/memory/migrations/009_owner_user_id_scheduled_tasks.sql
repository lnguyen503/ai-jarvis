-- Migration 009: owner_user_id plumbing for scheduled tasks (v1.10.0)
-- Closes v1.8.6 CP1 C2: scheduler-originated turns can now carry a userId
-- so they can call organize_* / memory_* tools. NULL = legacy owner-less task.
-- Safe on existing rows: ALTER TABLE ADD COLUMN with no DEFAULT leaves NULLs,
-- which is the intended "no owner" sentinel per ADR 005 decision 9.

ALTER TABLE scheduled_tasks ADD COLUMN owner_user_id INTEGER;

-- Supports /scheduled listByOwner and future per-user task queries (Item 4).
CREATE INDEX IF NOT EXISTS idx_tasks_owner_user
  ON scheduled_tasks(owner_user_id);
