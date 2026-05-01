-- Migration 016: Avengers plan tracking (v1.22.19).
--
-- A plan is a multi-step task created when Jarvis (orchestrator) delegates to
-- 2+ specialists in one turn within an assemble-mode group chat. Each plan
-- has N steps (one per delegation), a TODO message that Jarvis edits in place
-- to show live progress, and a final HTML deliverable that Jarvis composes
-- and uploads when all specialist steps complete.
--
-- Per-bot isolation: plans live ONLY in ai-jarvis's data dir. Specialists
-- don't read or write the plans table; their progress is observed by
-- Jarvis's gateway watching for peer-bot replies in the chat.

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  todo_message_id INTEGER,
  deliverable_path TEXT,
  deliverable_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_plans_chat_active ON plans(chat_id, status);

CREATE TABLE IF NOT EXISTS plan_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  bot_name TEXT NOT NULL,
  request TEXT NOT NULL,
  summary TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expanded INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  delegate_message_id INTEGER,
  reply_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, step_order);
CREATE INDEX IF NOT EXISTS idx_plan_steps_delegate_msg ON plan_steps(delegate_message_id) WHERE delegate_message_id IS NOT NULL;
