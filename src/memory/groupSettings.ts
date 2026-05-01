/**
 * GroupSettingsRepo — persists per-group enabled/disabled state +
 * v1.22.1 Avengers modes (chat + assemble).
 *
 * Absence of a row means the group defaults to enabled (since it was added
 * to allowedGroupIds). Avengers modes default to OFF (specialists wait for
 * explicit @-mention; orchestrator decides whether to delegate).
 */

import type { DbHandle, Statement } from './dbDriver.js';

export interface GroupSetting {
  chat_id: number;
  enabled: boolean;
  avengers_chat: boolean;
  avengers_assemble: boolean;
  updated_at: string;
}

/** v1.22.1 — Avengers mode flags returned by `getAvengersModes`. */
export interface AvengersModes {
  chat: boolean;
  assemble: boolean;
  /** v1.22.36 — debate-for-accuracy opt-in. Off by default; toggle via /avengers debate on|off. */
  debate: boolean;
}

export class GroupSettingsRepo {
  private readonly stmtGet: Statement;
  private readonly stmtUpsert: Statement;
  private readonly stmtUpsertAvengersChat: Statement;
  private readonly stmtUpsertAvengersAssemble: Statement;

  constructor(private readonly db: DbHandle) {
    this.stmtGet = db.prepare(`SELECT * FROM group_settings WHERE chat_id = ?`);
    this.stmtUpsert = db.prepare(`
      INSERT INTO group_settings (chat_id, enabled, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = datetime('now')
    `);
    // v1.22.1 — separate upserts so each Avengers flag toggles independently
    // without clobbering the other. Default values cover the case where the
    // row doesn't exist yet (enabled defaults to 1, the other flag to 0).
    this.stmtUpsertAvengersChat = db.prepare(`
      INSERT INTO group_settings (chat_id, enabled, avengers_chat, avengers_assemble, updated_at)
      VALUES (?, 1, ?, 0, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        avengers_chat = excluded.avengers_chat,
        updated_at = datetime('now')
    `);
    this.stmtUpsertAvengersAssemble = db.prepare(`
      INSERT INTO group_settings (chat_id, enabled, avengers_chat, avengers_assemble, updated_at)
      VALUES (?, 1, 0, ?, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        avengers_assemble = excluded.avengers_assemble,
        updated_at = datetime('now')
    `);
  }

  /**
   * Get the enabled state for a group chat.
   * Returns true if no row exists (default = enabled when in allowedGroupIds).
   */
  isEnabled(chatId: number): boolean {
    const row = this.stmtGet.get(chatId) as { enabled: number } | undefined;
    if (!row) return true; // default: enabled
    return row.enabled === 1;
  }

  /** Persist enabled/disabled state for a group */
  setEnabled(chatId: number, enabled: boolean): void {
    this.stmtUpsert.run(chatId, enabled ? 1 : 0);
  }

  /** Get full settings row if it exists */
  get(chatId: number): GroupSetting | undefined {
    const row = this.stmtGet.get(chatId) as
      | { chat_id: number; enabled: number; avengers_chat?: number; avengers_assemble?: number; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      chat_id: row.chat_id,
      enabled: row.enabled === 1,
      avengers_chat: row.avengers_chat === 1,
      avengers_assemble: row.avengers_assemble === 1,
      updated_at: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // v1.22.1 — Avengers mode getters/setters
  // -------------------------------------------------------------------------

  /**
   * Get both Avengers mode flags for a chat. Defaults to { chat: false,
   * assemble: false } when no row exists.
   */
  getAvengersModes(chatId: number): AvengersModes {
    const row = this.stmtGet.get(chatId) as
      | { avengers_chat?: number; avengers_assemble?: number; avengers_debate?: number }
      | undefined;
    return {
      chat: row?.avengers_chat === 1,
      assemble: row?.avengers_assemble === 1,
      debate: row?.avengers_debate === 1,
    };
  }

  /** Toggle the avengers_chat flag for a chat. */
  setAvengersChat(chatId: number, enabled: boolean): void {
    this.stmtUpsertAvengersChat.run(chatId, enabled ? 1 : 0);
  }

  /** Toggle the avengers_assemble flag for a chat. */
  setAvengersAssemble(chatId: number, enabled: boolean): void {
    this.stmtUpsertAvengersAssemble.run(chatId, enabled ? 1 : 0);
  }

  /** v1.22.36 — Toggle the avengers_debate flag (per-chat opt-in for debate-for-accuracy). */
  setAvengersDebate(chatId: number, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO group_settings (chat_id, enabled, avengers_chat, avengers_assemble, avengers_debate, updated_at)
         VALUES (?, 1, 0, 0, ?, datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           avengers_debate = excluded.avengers_debate,
           updated_at = datetime('now')`,
      )
      .run(chatId, enabled ? 1 : 0);
  }
}
