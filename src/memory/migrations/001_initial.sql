-- Migration 001: Initial schema
-- All timestamps are ISO-8601 TEXT; SQLite datetime('now') returns UTC.
-- 'projects' table intentionally excluded per ADR 001 Addendum A3.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','archived')) DEFAULT 'active',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat        ON sessions(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_sessions_chat_active ON sessions(telegram_chat_id, status);

CREATE TRIGGER IF NOT EXISTS sessions_updated_at AFTER UPDATE ON sessions
BEGIN
  UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content      TEXT,
  tool_name    TEXT,
  tool_input   TEXT,
  tool_output  TEXT,
  tool_use_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('preference','fact','note')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(category, key)
);

CREATE TRIGGER IF NOT EXISTS memory_updated_at AFTER UPDATE ON memory
BEGIN
  UPDATE memory SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  description     TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  command         TEXT NOT NULL,
  chat_id         INTEGER NOT NULL,
  last_run_at     TEXT,
  next_run_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active','paused')) DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);

CREATE TRIGGER IF NOT EXISTS scheduled_tasks_updated_at AFTER UPDATE ON scheduled_tasks
BEGIN
  UPDATE scheduled_tasks SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS command_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  command        TEXT NOT NULL,
  working_dir    TEXT NOT NULL,
  exit_code      INTEGER,
  stdout_preview TEXT,
  stderr_preview TEXT,
  duration_ms    INTEGER,
  killed         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cmdlog_created ON command_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmdlog_session  ON command_log(session_id);
