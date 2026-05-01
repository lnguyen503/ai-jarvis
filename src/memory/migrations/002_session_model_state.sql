-- Migration 002: per-session model override + cost accumulator
CREATE TABLE IF NOT EXISTS session_model_state (
  session_id          INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider            TEXT    NOT NULL DEFAULT 'ollama-cloud',
  model               TEXT    NOT NULL DEFAULT 'glm-5.1:cloud',
  override_until_clear INTEGER NOT NULL DEFAULT 0,  -- boolean: 1 if pinned via /model
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
