-- Migration 007: audit_log table (v1.6.0)
-- Timestamped audit trail for tool calls, model switches, admin commands, and confirmations.

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT NOT NULL,           -- 'tool_call' | 'model_switch' | 'admin_command' | 'confirmation' | 'compaction'
  actor_user_id INTEGER,
  actor_chat_id INTEGER,
  session_id INTEGER,
  detail_json TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_audit_log_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_log_session ON audit_log(session_id, ts DESC);
