/**
 * Nuclear option: archive all active sessions and abort any in-flight plans
 * for a specific group chat across all 4 Avengers bot DBs. One-shot cleanup
 * for testing — non-destructive (messages stay archived for recall_archive).
 *
 * Run:  npx tsx scripts/wipe-group-sessions.ts
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const GROUP_CHAT_ID = -1004234567890;
const BOTS = ['ai-jarvis', 'ai-tony', 'ai-natasha', 'ai-bruce'];

let totalSessions = 0;
let totalPlans = 0;

for (const bot of BOTS) {
  const dbPath = path.resolve('data', bot, 'jarvis.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`${bot}: no db at ${dbPath} — skipping`);
    continue;
  }

  const db = new DatabaseSync(dbPath);

  // 1. Archive active sessions for this group
  const sessions = db
    .prepare(`SELECT id FROM sessions WHERE telegram_chat_id = ? AND status = 'active'`)
    .all(GROUP_CHAT_ID) as Array<{ id: number }>;

  if (sessions.length > 0) {
    const stmt = db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = ?`);
    for (const s of sessions) {
      stmt.run(s.id);
      console.log(`${bot}: archived session ${s.id}`);
      totalSessions++;
    }
  }

  // 2. Abort any in-flight plans (active/synthesizing) — only ai-jarvis has these
  //    but all 4 dbs share the schema (migration applied per-bot).
  const plans = db
    .prepare(
      `SELECT id, status FROM plans WHERE chat_id = ? AND status IN ('active', 'synthesizing')`,
    )
    .all(GROUP_CHAT_ID) as Array<{ id: number; status: string }>;

  if (plans.length > 0) {
    const nowIso = new Date().toISOString();
    const stmt = db.prepare(
      `UPDATE plans SET status = 'aborted', closed_at = ?, updated_at = ? WHERE id = ?`,
    );
    for (const p of plans) {
      stmt.run(nowIso, nowIso, p.id);
      console.log(`${bot}: aborted plan ${p.id} (was ${p.status})`);
      totalPlans++;
    }
  }

  db.close();
}

console.log(
  `\n✓ Done. Archived ${totalSessions} session(s) and aborted ${totalPlans} in-flight plan(s) for chat ${GROUP_CHAT_ID}.`,
);
