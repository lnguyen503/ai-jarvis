/**
 * Cross-process group-state bridge (v1.23.0).
 *
 * Specialists run in their own pm2 process and don't have read access to
 * Jarvis's plans SQLite (per-bot data isolation). Without cross-process
 * visibility, a specialist tasked with a step can't see what its peers were
 * tasked with, or what they've delivered so far. Observed failure mode:
 * Bruce fabricates "Tony's hours = 40" because the input wasn't in chat
 * history yet.
 *
 * Same shared-file pattern used by debateTransport.ts: Jarvis's lifecycle
 * writes a small JSON snapshot to data/_shared/group-state/<chatId>.json on
 * every plan change. Specialist gateways read it on each turn and inject as
 * a <group-state> block in the user message (only in WORK mode — orchestrator
 * doesn't need it).
 *
 * Why a file (not a tool, not HTTP): debate transport already proves the
 * pattern. Writes are tiny (≤4 KB), reads are sub-ms, and no per-bot data
 * sandbox needs relaxation — the shared dir is at project root, accessible
 * to all 4 bot processes.
 */

import path from 'node:path';
import fs from 'node:fs';
import type pino from 'pino';

export interface GroupStateStep {
  bot: string;            // 'ai-tony' | 'ai-natasha' | 'ai-bruce'
  request: string;        // task text directed at this bot
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  summary: string | null; // one-line summary of bot's reply (when done)
}

export interface GroupStatePlan {
  id: number;
  task: string;             // the original user message that triggered the plan
  steps: GroupStateStep[];
  createdAt: string;        // ISO 8601
}

export interface GroupStateSnapshot {
  chatId: number;
  activePlan: GroupStatePlan | null;
  updatedAt: string;        // ISO 8601 — for staleness detection
}

const SHARED_DIR = path.resolve(process.cwd(), 'data', '_shared', 'group-state');

/** Stale-state TTL — 24h. Files older than this are ignored on read. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
  } catch {
    // best-effort; if mkdir fails the write below will surface the error
  }
}

function pathFor(chatId: number): string {
  return path.join(SHARED_DIR, `${chatId}.json`);
}

/**
 * Write the group-state snapshot atomically. Jarvis's lifecycle calls this
 * on every plan change (create, step-done, deliver, abort). Best-effort:
 * write failures are logged but don't block the lifecycle event itself.
 */
export function writeGroupState(snapshot: GroupStateSnapshot, logger?: pino.Logger): void {
  ensureDir();
  const filePath = pathFor(snapshot.chatId);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmpPath, filePath);
    logger?.debug(
      { chatId: snapshot.chatId, hasActivePlan: snapshot.activePlan !== null },
      'group-state: wrote snapshot',
    );
  } catch (err) {
    logger?.warn(
      { chatId: snapshot.chatId, err: err instanceof Error ? err.message : String(err) },
      'group-state: write failed (specialists will see no shared state this turn)',
    );
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Read the group-state snapshot for `chatId`. Returns null when no file
 * exists, the file is older than STALE_AFTER_MS, or read/parse fails.
 * Specialists call this on each turn (in WORK mode) to inject as
 * `<group-state>` in the system prompt.
 */
export function readGroupState(chatId: number, logger?: pino.Logger): GroupStateSnapshot | null {
  const filePath = pathFor(chatId);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;  // no snapshot → no state to inject
  }
  let parsed: GroupStateSnapshot;
  try {
    parsed = JSON.parse(raw) as GroupStateSnapshot;
  } catch (err) {
    logger?.warn(
      { chatId, err: err instanceof Error ? err.message : String(err) },
      'group-state: parse failed — treating as no state',
    );
    return null;
  }
  // Staleness check.
  try {
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (age > STALE_AFTER_MS) {
      return null;
    }
  } catch {
    return null;
  }
  return parsed;
}

/**
 * Render the snapshot as a `<group-state>` block suitable for inclusion in
 * the user message of a specialist's WORK turn. Compact JSON; the block is
 * for model consumption, not human display.
 */
export function renderGroupStateBlock(snapshot: GroupStateSnapshot): string {
  if (snapshot.activePlan === null) {
    return `<group-state>{"activePlan":null}</group-state>`;
  }
  const plan = snapshot.activePlan;
  const compact = {
    activePlan: {
      id: plan.id,
      task: plan.task.slice(0, 500),
      steps: plan.steps.map((s) => ({
        bot: s.bot,
        request: s.request.slice(0, 500),
        status: s.status,
        ...(s.summary ? { summary: s.summary.slice(0, 200) } : {}),
      })),
    },
  };
  return `<group-state>${JSON.stringify(compact)}</group-state>`;
}

/**
 * Delete the snapshot for a chat. Used when a plan is delivered or aborted
 * and we want specialists to see "no active plan" on subsequent turns.
 */
export function clearGroupState(chatId: number, logger?: pino.Logger): void {
  const filePath = pathFor(chatId);
  try {
    fs.unlinkSync(filePath);
    logger?.debug({ chatId }, 'group-state: cleared snapshot');
  } catch {
    // file already gone — not an error
  }
}
