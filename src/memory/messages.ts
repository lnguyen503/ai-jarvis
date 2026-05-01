import type { DbHandle, Statement } from './dbDriver.js';

export interface Message {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_use_id: string | null;
  created_at: string;
}

export interface InsertMessageParams {
  session_id: number;
  role: Message['role'];
  content?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  tool_output?: string | null;
  tool_use_id?: string | null;
}

export class MessagesRepo {
  private readonly stmtInsert: Statement;
  private readonly stmtListRecent: Statement;
  private readonly stmtDeleteForSession: Statement;

  constructor(private readonly db: DbHandle) {
    this.stmtInsert = db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_name, tool_input, tool_output, tool_use_id)
       VALUES (@session_id, @role, @content, @tool_name, @tool_input, @tool_output, @tool_use_id)`,
    );
    // Session scoping invariant (W3): MUST filter by session_id.
    // Subquery selects the most recent N rows (DESC), outer query re-sorts ASC
    // so downstream contextBuilder receives chronological order.
    // id is included as tiebreaker because created_at has 1-second resolution.
    this.stmtListRecent = db.prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.stmtDeleteForSession = db.prepare(
      `DELETE FROM messages WHERE session_id = ?`,
    );
  }

  insert(params: InsertMessageParams): number {
    const result = this.stmtInsert.run({
      session_id: params.session_id,
      role: params.role,
      content: params.content ?? null,
      tool_name: params.tool_name ?? null,
      tool_input: params.tool_input ?? null,
      tool_output: params.tool_output ?? null,
      tool_use_id: params.tool_use_id ?? null,
    });
    return result.lastInsertRowid as number;
  }

  /** List the most recent N messages for a session in chronological (ASC) order. */
  listRecent(sessionId: number, limit: number): Message[] {
    return this.stmtListRecent.all(sessionId, limit) as Message[];
  }

  /** Delete all messages for a session (used by compaction before inserting summary). */
  deleteForSession(sessionId: number): void {
    this.stmtDeleteForSession.run(sessionId);
  }
}
