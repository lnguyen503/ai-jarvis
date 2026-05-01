-- Migration 003: group chat user activity tracking + per-group enabled/disabled state

CREATE TABLE IF NOT EXISTS group_user_activity (
  group_id        INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  username        TEXT,
  message_count   INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  last_active_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  window_start_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gua_group ON group_user_activity(group_id);

CREATE TABLE IF NOT EXISTS group_settings (
  chat_id    INTEGER PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,  -- BOOLEAN: 1=enabled, 0=disabled
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_rate_limit_overrides (
  group_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  rate_limit INTEGER NOT NULL DEFAULT 0,  -- 0 = use default
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
