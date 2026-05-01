import type { DbHandle, Statement } from './dbDriver.js';

export interface ScheduledTask {
  id: number;
  description: string;
  cron_expression: string;
  command: string;
  chat_id: number;
  /** v1.10.0 — NULL for legacy or owner-less tasks (migration 009). */
  owner_user_id: number | null;
  last_run_at: string | null;
  next_run_at: string | null;
  status: 'active' | 'paused';
  created_at: string;
  updated_at: string;
}

export class ScheduledTasksRepo {
  private readonly stmtListActive: Statement;
  private readonly stmtInsert: Statement;
  private readonly stmtUpdateLastRun: Statement;
  private readonly stmtSetStatus: Statement;
  private readonly stmtDelete: Statement;
  private readonly stmtListByOwner: Statement;
  private readonly stmtListAll: Statement;
  private readonly stmtGet: Statement;
  private readonly stmtUpdateDescription: Statement;

  constructor(private readonly db: DbHandle) {
    this.stmtListActive = db.prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY id ASC`,
    );
    this.stmtInsert = db.prepare(
      `INSERT INTO scheduled_tasks (description, cron_expression, command, chat_id, owner_user_id, status)
       VALUES (@description, @cron_expression, @command, @chat_id, @owner_user_id, 'active')`,
    );
    this.stmtUpdateLastRun = db.prepare(
      `UPDATE scheduled_tasks SET last_run_at = datetime('now') WHERE id = ?`,
    );
    this.stmtSetStatus = db.prepare(
      `UPDATE scheduled_tasks SET status = ? WHERE id = ?`,
    );
    this.stmtDelete = db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`);
    // v1.10.0 — per-owner listing (both active and paused, status filter in command layer)
    this.stmtListByOwner = db.prepare(
      `SELECT * FROM scheduled_tasks WHERE owner_user_id = ? ORDER BY id ASC`,
    );
    // v1.10.0 — admin-only: all tasks including NULL-owner (orphan) rows
    this.stmtListAll = db.prepare(
      `SELECT * FROM scheduled_tasks ORDER BY id ASC`,
    );
    // v1.10.0 — single-row lookup by id (used by /scheduled show/pause/resume/delete)
    this.stmtGet = db.prepare(
      `SELECT * FROM scheduled_tasks WHERE id = ?`,
    );
    // v1.20.0 ADR 020 D2 — migration: rewrite description in-place
    this.stmtUpdateDescription = db.prepare(
      `UPDATE scheduled_tasks SET description = ? WHERE id = ?`,
    );
  }

  listActive(): ScheduledTask[] {
    return this.stmtListActive.all() as ScheduledTask[];
  }

  /**
   * v1.10.0 — list tasks owned by a specific user (active AND paused).
   * NULL-owner tasks are not included. The command layer applies status filtering.
   */
  listByOwner(ownerUserId: number): ScheduledTask[] {
    return this.stmtListByOwner.all(ownerUserId) as ScheduledTask[];
  }

  /**
   * v1.10.0 — list ALL tasks including NULL-owner (orphan) rows.
   * Admin-only usage; used by `/scheduled list all`.
   */
  listAll(): ScheduledTask[] {
    return this.stmtListAll.all() as ScheduledTask[];
  }

  /**
   * v1.10.0 — single-row lookup by id.
   * Returns null if no row with that id exists.
   */
  get(id: number): ScheduledTask | null {
    return (this.stmtGet.get(id) as ScheduledTask | undefined) ?? null;
  }

  insert(params: {
    description: string;
    cron_expression: string;
    command: string;
    chat_id: number;
    /** v1.10.0 — optional; defaults to NULL (legacy/owner-less). */
    owner_user_id?: number | null;
  }): number {
    const result = this.stmtInsert.run({
      description: params.description,
      cron_expression: params.cron_expression,
      command: params.command,
      chat_id: params.chat_id,
      owner_user_id: params.owner_user_id ?? null,
    });
    return result.lastInsertRowid as number;
  }

  markRan(id: number): void {
    this.stmtUpdateLastRun.run(id);
  }

  setStatus(id: number, status: 'active' | 'paused'): void {
    this.stmtSetStatus.run(status, id);
  }

  remove(id: number): void {
    this.stmtDelete.run(id);
  }

  /**
   * v1.20.0 ADR 020 D2 — migration helper: rewrite the description of a task in-place.
   * Used exclusively by migrateLegacyCoachTasks() in src/coach/migration.ts.
   * NOT exposed for general use — description rewrites outside migration are a data model violation.
   */
  updateDescription(id: number, description: string): void {
    this.stmtUpdateDescription.run(description, id);
  }
}
