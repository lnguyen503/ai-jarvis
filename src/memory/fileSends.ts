/**
 * FileSendsRepo — audit log for send_file tool invocations (v1.5.0).
 *
 * Each row records a file-send attempt: path, size, kind (document/photo),
 * Telegram message id (on success), ok flag, and scrubbed error (on failure).
 */

import type { DbHandle } from './dbDriver.js';

export interface FileSendRow {
  id: number;
  session_id: number;
  chat_id: number;
  path: string;
  basename: string;
  bytes: number;
  ext: string;
  kind: string;
  telegram_message_id: number | null;
  ok: number; // SQLite stores BOOLEAN as 0/1
  error: string | null;
  created_at: string;
}

export interface InsertFileSendParams {
  session_id: number;
  chat_id: number;
  path: string;
  basename: string;
  bytes: number;
  ext: string;
  kind: 'document' | 'photo';
  telegram_message_id?: number | null;
  ok: boolean;
  error?: string | null;
}

export class FileSendsRepo {
  constructor(private readonly db: DbHandle) {}

  insert(params: InsertFileSendParams): number {
    const result = this.db
      .prepare(
        `INSERT INTO file_sends
           (session_id, chat_id, path, basename, bytes, ext, kind,
            telegram_message_id, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.session_id,
        params.chat_id,
        params.path,
        params.basename,
        params.bytes,
        params.ext,
        params.kind,
        params.telegram_message_id ?? null,
        params.ok ? 1 : 0,
        params.error ?? null,
      );
    return result.lastInsertRowid as number;
  }

  /**
   * List recent sends for a session, newest first.
   * Session-scoped (invariant W3).
   */
  listRecent(sessionId: number, limit = 20): FileSendRow[] {
    return this.db
      .prepare(
        `SELECT * FROM file_sends
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as FileSendRow[];
  }
}
