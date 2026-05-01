import type { DbHandle, Statement } from './dbDriver.js';

export interface Session {
  id: number;
  telegram_chat_id: number;
  status: 'active' | 'archived';
  created_at: string;
  last_active_at: string;
  updated_at: string;
}

export class SessionsRepo {
  private readonly stmtGetActive: Statement;
  private readonly stmtCreate: Statement;
  private readonly stmtUpdateActive: Statement;
  private readonly stmtArchive: Statement;
  private readonly stmtGetById: Statement;

  constructor(private readonly db: DbHandle) {
    // Session scoping invariant (W3): EVERY query MUST filter by telegram_chat_id
    this.stmtGetActive = db.prepare(
      `SELECT * FROM sessions WHERE telegram_chat_id = ? AND status = 'active' ORDER BY last_active_at DESC LIMIT 1`,
    );
    this.stmtCreate = db.prepare(
      `INSERT INTO sessions (telegram_chat_id) VALUES (?) RETURNING *`,
    );
    this.stmtUpdateActive = db.prepare(
      `UPDATE sessions SET last_active_at = datetime('now') WHERE id = ? AND telegram_chat_id = ?`,
    );
    this.stmtArchive = db.prepare(
      `UPDATE sessions SET status = 'archived' WHERE id = ? AND telegram_chat_id = ?`,
    );
    // Note: getById still scopes by telegram_chat_id for safety
    this.stmtGetById = db.prepare(
      `SELECT * FROM sessions WHERE id = ? AND telegram_chat_id = ?`,
    );
  }

  /**
   * Get the active session for a chat, or create one if none exists.
   * This is the ONLY entry point for sessions — enforces telegram_chat_id scoping.
   */
  getOrCreate(chatId: number): Session {
    const existing = this.stmtGetActive.get(chatId) as Session | undefined;
    if (existing) {
      this.stmtUpdateActive.run(existing.id, chatId);
      return { ...existing, last_active_at: new Date().toISOString() };
    }
    const rows = this.stmtCreate.all(chatId) as Session[];
    const created = rows[0];
    if (!created) {
      throw new Error(`Failed to create session for chatId=${chatId}`);
    }
    return created;
  }

  getById(sessionId: number, chatId: number): Session | undefined {
    return this.stmtGetById.get(sessionId, chatId) as Session | undefined;
  }

  touchLastActive(sessionId: number, chatId: number): void {
    this.stmtUpdateActive.run(sessionId, chatId);
  }

  archive(sessionId: number, chatId: number): void {
    this.stmtArchive.run(sessionId, chatId);
  }
}
