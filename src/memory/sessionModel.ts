/**
 * SessionModelStateRepo — per-session model override + cost accumulator.
 * Backed by the session_model_state table (migration 002).
 */

import type { DbHandle } from './dbDriver.js';

export interface SessionModelState {
  session_id: number;
  provider: string;
  model: string;
  override_until_clear: boolean;
  input_tokens: number;
  output_tokens: number;
  updated_at: string;
}

export class SessionModelStateRepo {
  constructor(private readonly db: DbHandle) {}

  /** Get state for a session, or undefined if not yet set. */
  get(sessionId: number): SessionModelState | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_model_state WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this._map(row);
  }

  /**
   * Upsert provider/model for a session.
   * If override=true, marks it as a user-pinned model (persists until /model auto).
   */
  setModel(
    sessionId: number,
    provider: string,
    model: string,
    override = false,
  ): void {
    this.db.prepare(`
      INSERT INTO session_model_state (session_id, provider, model, override_until_clear, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        override_until_clear = excluded.override_until_clear,
        updated_at = excluded.updated_at
    `).run(sessionId, provider, model, override ? 1 : 0);
  }

  /**
   * Clear the per-session model pin (return to auto-routing).
   * Preserves token counters.
   */
  clearOverride(sessionId: number): void {
    this.db.prepare(`
      UPDATE session_model_state
      SET override_until_clear = 0, updated_at = datetime('now')
      WHERE session_id = ?
    `).run(sessionId);
  }

  /**
   * Accumulate token usage for a session.
   * Creates a row if it doesn't exist yet (with defaults).
   */
  accumulateTokens(
    sessionId: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    this.db.prepare(`
      INSERT INTO session_model_state (session_id, input_tokens, output_tokens, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        updated_at = excluded.updated_at
    `).run(sessionId, inputTokens, outputTokens);
  }

  /** Reset token counters for a session (e.g., after /clear). */
  resetTokens(sessionId: number): void {
    this.db.prepare(`
      UPDATE session_model_state
      SET input_tokens = 0, output_tokens = 0, updated_at = datetime('now')
      WHERE session_id = ?
    `).run(sessionId);
  }

  private _map(row: Record<string, unknown>): SessionModelState {
    return {
      session_id: row['session_id'] as number,
      provider: row['provider'] as string,
      model: row['model'] as string,
      override_until_clear: (row['override_until_clear'] as number) === 1,
      input_tokens: row['input_tokens'] as number,
      output_tokens: row['output_tokens'] as number,
      updated_at: row['updated_at'] as string,
    };
  }
}
