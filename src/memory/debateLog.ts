/**
 * DebateRunsRepo + DebateRoundsRepo — debate persistence layer (v1.16.0).
 *
 * Two repos covering the debate_runs and debate_rounds tables created
 * by migration 013. These tables are additive — the audit_log debate.complete
 * row remains the forensic source of truth. These repos serve the
 * /api/webapp/debates list/detail/stream endpoints.
 *
 * ADR 016 D2 + R6 (zombie cleanup) + R2 (concurrency cap).
 */

import { randomUUID } from 'node:crypto';
import type { DbHandle } from './dbDriver.js';
import { child } from '../logger/index.js';

const log = child({ component: 'memory.debateLog' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DebateRunStatus = 'running' | 'complete' | 'aborted';

export interface DebateRunRow {
  id: string;
  user_id: number;
  topic: string;
  model_lineup_json: string;
  participant_count: number;
  rounds_target: number;
  rounds_completed: number;
  status: DebateRunStatus;
  verdict_json: string | null;
  reasoning: string | null;
  created_at: string;
  updated_at: string;
  abort_reason: string | null;
}

export interface DebateRoundRow {
  id: string;
  debate_run_id: string;
  round_number: number;
  debater_name: string;
  model_name: string;
  content: string;
  ts: string;
}

export interface CreateDebateRunParams {
  id?: string;
  userId: number;
  topic: string;
  modelLineupJson: string;
  participantCount: number;
  roundsTarget: number;
}

export interface AppendDebateRoundParams {
  debateRunId: string;
  roundNumber: number;
  debaterName: string;
  modelName: string;
  content: string;
}

export interface FindDebateRunsOptions {
  limit?: number;
  offset?: number;
}

export interface UpdateDebateRunFields {
  status?: DebateRunStatus;
  roundsCompleted?: number;
  verdictJson?: string | null;
  reasoning?: string | null;
  abortReason?: string | null;
}

// ---------------------------------------------------------------------------
// DebateRunsRepo
// ---------------------------------------------------------------------------

/**
 * CRUD operations for the debate_runs table.
 *
 * All writes use per-user scoping for cross-user isolation. findByIdScoped
 * is a single-query pattern (ADR 016 P8 binding) — WHERE id = ? AND user_id = ?.
 */
export class DebateRunsRepo {
  constructor(private readonly db: DbHandle) {}

  /**
   * Insert a new debate_runs row with status='running'.
   * Returns the run id (either the provided id or a generated UUID).
   */
  create(params: CreateDebateRunParams): string {
    const id = params.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO debate_runs
           (id, user_id, topic, model_lineup_json, participant_count,
            rounds_target, rounds_completed, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'running', ?, ?)`,
      )
      .run(
        id,
        params.userId,
        params.topic,
        params.modelLineupJson,
        params.participantCount,
        params.roundsTarget,
        now,
        now,
      );
    return id;
  }

  /**
   * List debate runs for a user, newest first.
   * Per-user scoping: WHERE user_id = ? ORDER BY created_at DESC.
   */
  findByUser(userId: number, options: FindDebateRunsOptions = {}): DebateRunRow[] {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    return this.db
      .prepare(
        `SELECT id, user_id, topic, model_lineup_json, participant_count,
                rounds_target, rounds_completed, status, verdict_json,
                reasoning, created_at, updated_at, abort_reason
         FROM debate_runs
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(userId, limit, offset) as DebateRunRow[];
  }

  /**
   * Fetch a single run, scoped to the authenticated user.
   * ADR 016 P8 binding: SINGLE SQL query — WHERE id = ? AND user_id = ?.
   * Returns null if not found OR if it belongs to a different user.
   */
  findByIdScoped(id: string, userId: number): DebateRunRow | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, topic, model_lineup_json, participant_count,
                rounds_target, rounds_completed, status, verdict_json,
                reasoning, created_at, updated_at, abort_reason
         FROM debate_runs
         WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as DebateRunRow | undefined;
    return row ?? null;
  }

  /**
   * Update mutable fields on a debate_runs row.
   * Always updates updated_at to now.
   */
  update(id: string, fields: UpdateDebateRunFields): void {
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    if (fields.status !== undefined) {
      sets.push('status = ?');
      values.push(fields.status);
    }
    if (fields.roundsCompleted !== undefined) {
      sets.push('rounds_completed = ?');
      values.push(fields.roundsCompleted);
    }
    if (fields.verdictJson !== undefined) {
      sets.push('verdict_json = ?');
      values.push(fields.verdictJson);
    }
    if (fields.reasoning !== undefined) {
      sets.push('reasoning = ?');
      values.push(fields.reasoning);
    }
    if (fields.abortReason !== undefined) {
      sets.push('abort_reason = ?');
      values.push(fields.abortReason);
    }

    values.push(id);

    this.db.prepare(`UPDATE debate_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Count running debates for a user (used by R2 concurrency cap).
   */
  countRunning(userId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM debate_runs WHERE user_id = ? AND status = 'running'`)
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  /**
   * R6 zombie cleanup: mark stale 'running' rows as 'aborted' with reason
   * 'pm2_restart'. Called once at boot after migrations run.
   *
   * 5-minute threshold: rows updated within the last 5 minutes are NOT touched
   * (could be legitimately in-flight from a process that survived or just started).
   */
  cleanupZombies(): number {
    const result = this.db
      .prepare(
        `UPDATE debate_runs
           SET status = 'aborted',
               abort_reason = 'pm2_restart',
               updated_at = datetime('now')
         WHERE status = 'running'
           AND updated_at < datetime('now', '-5 minutes')`,
      )
      .run();
    const count = Number(result.changes);
    if (count > 0) {
      log.info({ component: 'memory', count }, `cleaned up ${count} zombie debate_runs at boot`);
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// DebateRoundsRepo
// ---------------------------------------------------------------------------

/**
 * Append-only operations for the debate_rounds table.
 *
 * Each debater turn produces one row. The UNIQUE(debate_run_id, round_number,
 * debater_name) constraint prevents duplicate inserts (idempotent on retry).
 */
export class DebateRoundsRepo {
  constructor(private readonly db: DbHandle) {}

  /**
   * Append a single debater turn for a debate run.
   * Returns the generated round row id.
   */
  append(params: AppendDebateRoundParams): string {
    const id = randomUUID();
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO debate_rounds
           (id, debate_run_id, round_number, debater_name, model_name, content, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.debateRunId,
        params.roundNumber,
        params.debaterName,
        params.modelName,
        params.content,
        ts,
      );
    return id;
  }

  /**
   * List all rounds for a debate run, ordered by round_number ASC, then insertion order.
   */
  listByRun(debateRunId: string): DebateRoundRow[] {
    return this.db
      .prepare(
        `SELECT id, debate_run_id, round_number, debater_name, model_name, content, ts
         FROM debate_rounds
         WHERE debate_run_id = ?
         ORDER BY round_number ASC, ts ASC`,
      )
      .all(debateRunId) as DebateRoundRow[];
  }
}
