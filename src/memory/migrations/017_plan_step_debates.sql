-- Migration 017: Avengers debate-for-accuracy transcripts (v1.22.35).
--
-- When a specialist replies to a delegated step in an active plan, the
-- specialist's draft is reviewed by Jarvis-as-critic. Up to 3 rounds:
-- specialist drafts → critic verdicts (APPROVE/REVISE) → specialist revises.
-- Early-exit on APPROVE. Contested if 3 rounds without APPROVE.
--
-- Each row in plan_step_debates is one turn (specialist or critic) within
-- a debate. The full transcript per step is what the dashboard renders.

CREATE TABLE IF NOT EXISTS plan_step_debates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES plan_steps(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  speaker TEXT NOT NULL,                      -- 'specialist' | 'critic'
  model TEXT NOT NULL,                        -- e.g. 'qwen3-coder:480b' or 'glm-5.1'
  text TEXT NOT NULL,
  verdict TEXT,                               -- 'approve' | 'revise' | NULL (only critic rows have verdicts)
  created_at TEXT NOT NULL                    -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_pstd_step_round ON plan_step_debates(step_id, round, id);

-- Per-step debate metadata. Updated by the lifecycle when a debate completes.
ALTER TABLE plan_steps ADD COLUMN debate_status TEXT NOT NULL DEFAULT 'none';
-- values: 'none' (no debate ran) | 'approved' (critic APPROVED) | 'contested' (3 rounds without approve)
ALTER TABLE plan_steps ADD COLUMN debate_rounds INTEGER NOT NULL DEFAULT 0;
