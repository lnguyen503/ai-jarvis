-- Migration 006: file_sends audit table (v1.5.0)
-- Tracks every send_file tool invocation for security auditing.

CREATE TABLE file_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  basename TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  ext TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'document' or 'photo'
  telegram_message_id INTEGER,
  ok BOOLEAN NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_file_sends_session ON file_sends(session_id, created_at DESC);
