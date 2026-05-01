/**
 * EmailSendsRepo — pending-state store + audit log for Gmail sends (v1.7.15).
 *
 * Every gmail_draft call inserts a pending row. Confirmation transitions it
 * to 'sent' (on success) or 'failed'. TTL sweeps move unconfirmed rows to
 * 'expired'. Rate-limiting counts 'sent' rows in the last hour.
 *
 * The row is intentionally wide — we keep the full proposed content (with
 * body_preview truncated) so you can audit after the fact what the agent
 * wanted to send vs what actually went out.
 */

import type { DbHandle } from './dbDriver.js';

export type EmailSendStatus = 'pending' | 'sent' | 'failed' | 'expired' | 'cancelled';

export interface EmailSendRow {
  id: number;
  token: string;
  draft_id: string;
  session_id: number;
  chat_id: number;
  user_id: number;
  from_addr: string;
  to_addrs: string;          // JSON-encoded string[]
  cc_addrs: string;
  bcc_addrs: string;
  subject: string;
  body_preview: string;
  body_hash: string;
  status: EmailSendStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  error: string | null;
  sent_message_id: string | null;
}

export interface InsertEmailSendParams {
  token: string;
  draft_id: string;
  session_id: number;
  chat_id: number;
  user_id: number;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  bcc_addrs: string[];
  subject: string;
  body_preview: string;
  body_hash: string;
  /** ISO timestamp. */
  expires_at: string;
}

export class EmailSendsRepo {
  constructor(private readonly db: DbHandle) {}

  insert(params: InsertEmailSendParams): number {
    const result = this.db
      .prepare(
        `INSERT INTO email_sends
           (token, draft_id, session_id, chat_id, user_id,
            from_addr, to_addrs, cc_addrs, bcc_addrs,
            subject, body_preview, body_hash, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        params.token,
        params.draft_id,
        params.session_id,
        params.chat_id,
        params.user_id,
        params.from_addr,
        JSON.stringify(params.to_addrs),
        JSON.stringify(params.cc_addrs),
        JSON.stringify(params.bcc_addrs),
        params.subject,
        params.body_preview,
        params.body_hash,
        params.expires_at,
      );
    return result.lastInsertRowid as number;
  }

  findByToken(token: string): EmailSendRow | null {
    const row = this.db
      .prepare('SELECT * FROM email_sends WHERE token = ?')
      .get(token) as EmailSendRow | undefined;
    return row ?? null;
  }

  markSent(id: number, sentMessageId: string): void {
    this.db
      .prepare(
        `UPDATE email_sends
            SET status = 'sent',
                consumed_at = datetime('now'),
                sent_message_id = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(sentMessageId, id);
  }

  markFailed(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE email_sends
            SET status = 'failed',
                consumed_at = datetime('now'),
                error = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(error, id);
  }

  markCancelled(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE email_sends
            SET status = 'cancelled',
                consumed_at = datetime('now'),
                error = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(reason, id);
  }

  /**
   * Sweep pending rows whose expires_at has passed. Returns the rows so the
   * caller can delete their associated Gmail drafts if desired.
   *
   * Run this periodically (e.g. every minute) from a gateway tick.
   */
  sweepExpired(): EmailSendRow[] {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const rows = this.db
      .prepare(
        `SELECT * FROM email_sends
          WHERE status = 'pending'
            AND expires_at <= ?`,
      )
      .all(now) as EmailSendRow[];
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(
          `UPDATE email_sends
              SET status = 'expired', consumed_at = datetime('now')
            WHERE id IN (${placeholders})`,
        )
        .run(...ids);
    }
    return rows;
  }

  /**
   * Count successful SENT rows in the last `windowSeconds`. Used by the
   * rate-limit guard before a new draft is staged.
   */
  countSentInWindow(windowSeconds: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM email_sends
          WHERE status = 'sent'
            AND consumed_at >= datetime('now', ?)`,
      )
      .get(`-${windowSeconds} seconds`) as { c: number };
    return row.c;
  }

  listRecent(limit = 50): EmailSendRow[] {
    return this.db
      .prepare('SELECT * FROM email_sends ORDER BY id DESC LIMIT ?')
      .all(limit) as EmailSendRow[];
  }
}
