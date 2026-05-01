-- Migration 013: debate_runs + debate_rounds tables (v1.16.0)
--
-- New persistence layer for the live /webapp/debate/ viewer. The Telegram
-- panel + audit_log debate.complete row REMAIN — debate_runs/_rounds is
-- additive, not a replacement. Audit row stays the source-of-truth for
-- forensics; debate_runs is the user-queryable history surface.
--
-- Forwards-only (per ADR 002 migration policy). Idempotent via IF NOT EXISTS.
--
-- ADR 016 D2 schema (binding for Phase 2).

CREATE TABLE IF NOT EXISTS debate_runs (
  id                TEXT PRIMARY KEY,                    -- UUID v4 (lowercase, no braces)
  user_id           INTEGER NOT NULL,                    -- Telegram user id of the debate initiator
  topic             TEXT NOT NULL,                       -- scrubbed topic (matches state.topic)
  model_lineup_json TEXT NOT NULL,                       -- JSON array: [{debaterName, modelName, providerName}, ...]
  participant_count INTEGER NOT NULL,                    -- roster.length (4 today; future-proof for /debate /size)
  rounds_target     INTEGER NOT NULL,                    -- planned maxRounds (post-clamp 1..5)
  rounds_completed  INTEGER NOT NULL DEFAULT 0,          -- monotonically incremented as rounds finish
  status            TEXT NOT NULL CHECK (status IN ('running', 'complete', 'aborted')),
  verdict_json      TEXT,                                -- nullable until terminal; JSON of the verdict object
  reasoning         TEXT,                                -- nullable; final-arbiter rationale prose
  created_at        TEXT NOT NULL,                       -- ISO 8601 UTC
  updated_at        TEXT NOT NULL,                       -- ISO 8601 UTC
  abort_reason      TEXT                                 -- nullable; populated when status='aborted'
);

CREATE INDEX IF NOT EXISTS idx_debate_runs_user_created
  ON debate_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS debate_rounds (
  id              TEXT PRIMARY KEY,                                    -- UUID v4
  debate_run_id   TEXT NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,                                    -- 1-indexed; matches DebateState.currentRound
  debater_name    TEXT NOT NULL,                                       -- debater human label (Claude / GLM / etc.)
  model_name      TEXT NOT NULL,                                       -- Ollama model id (glm-5.1:cloud, etc.)
  content         TEXT NOT NULL,                                       -- post-scrub turn text
  ts              TEXT NOT NULL,                                       -- ISO 8601 UTC
  UNIQUE(debate_run_id, round_number, debater_name)
);

CREATE INDEX IF NOT EXISTS idx_debate_rounds_run_round
  ON debate_rounds(debate_run_id, round_number);
