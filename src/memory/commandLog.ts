import type { DbHandle, Statement } from './dbDriver.js';

export interface CommandLogEntry {
  id: number;
  session_id: number | null;
  command: string;
  working_dir: string;
  exit_code: number | null;
  stdout_preview: string | null;
  stderr_preview: string | null;
  duration_ms: number | null;
  killed: 0 | 1;
  created_at: string;
}

export interface InsertCommandLogParams {
  session_id?: number | null;
  command: string;
  working_dir: string;
  exit_code?: number | null;
  stdout_preview?: string | null;
  stderr_preview?: string | null;
  duration_ms?: number | null;
  killed?: boolean;
}

export class CommandLogRepo {
  private readonly stmtInsert: Statement;
  private readonly stmtListForSession: Statement;
  private readonly stmtListRecent: Statement;

  constructor(private readonly db: DbHandle) {
    this.stmtInsert = db.prepare(
      `INSERT INTO command_log (session_id, command, working_dir, exit_code, stdout_preview, stderr_preview, duration_ms, killed)
       VALUES (@session_id, @command, @working_dir, @exit_code, @stdout_preview, @stderr_preview, @duration_ms, @killed)`,
    );
    // Session scoping invariant (W3): MUST filter by session_id
    // Tiebreak by id DESC because datetime('now') has 1-second resolution
    this.stmtListForSession = db.prepare(
      `SELECT * FROM command_log WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    this.stmtListRecent = db.prepare(
      `SELECT * FROM command_log ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
  }

  insert(params: InsertCommandLogParams): number {
    const result = this.stmtInsert.run({
      session_id: params.session_id ?? null,
      command: params.command,
      working_dir: params.working_dir,
      exit_code: params.exit_code ?? null,
      stdout_preview: params.stdout_preview ?? null,
      stderr_preview: params.stderr_preview ?? null,
      duration_ms: params.duration_ms ?? null,
      killed: params.killed ? 1 : 0,
    });
    return result.lastInsertRowid as number;
  }

  /** List commands for a specific session — scoped by session_id (W3) */
  listForSession(sessionId: number, limit = 20): CommandLogEntry[] {
    return this.stmtListForSession.all(sessionId, limit) as CommandLogEntry[];
  }

  /** List recent commands across all sessions (for /history command) */
  listRecent(limit = 20): CommandLogEntry[] {
    return this.stmtListRecent.all(limit) as CommandLogEntry[];
  }
}
