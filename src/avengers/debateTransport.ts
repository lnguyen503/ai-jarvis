/**
 * Cross-process debate transcript transport (v1.22.35).
 *
 * Specialists run debates in their own pm2 process. Jarvis owns the plans
 * SQLite. To get transcripts from specialist process → Jarvis's DB without
 * adding HTTP infrastructure or relaxing the per-bot data sandbox at the
 * tool level, we use a tiny file-based bridge:
 *
 *   1. Specialist runs debate, captures rounds + outcome
 *   2. Specialist writes JSON to data/_shared/debates/<chatId>-<bot>-<ts>.json
 *   3. Specialist posts final answer to chat
 *   4. Jarvis's gateway, when observing the peer-bot reply via
 *      markStepDoneFromReply, scans the shared dir for matching transcript,
 *      persists to plans_step_debates, deletes the file
 *
 * The shared dir is at the project root data tree (data/_shared/) so it's
 * accessible to all 4 bot processes (same user, same disk). It's NOT under
 * any per-bot dataDir — that's intentional, this is the only shared write
 * surface in the project. Files are tiny (~10 KB max) and cleaned up on
 * pickup; a stale-file evictor sweeps anything older than 1 hour as a
 * belt-and-braces step.
 */

import path from 'node:path';
import fs from 'node:fs';
import type pino from 'pino';
import type { DebateRound, DebateOutcomeKind } from './debate.js';

export interface PersistedTranscript {
  chatId: number;
  specialistBotName: string;
  request: string;
  outcome: DebateOutcomeKind;
  totalRoundsRun: number;
  rounds: DebateRound[];
  /** When the specialist wrote the file (specialist process clock). */
  writtenAt: string;
}

const SHARED_DIR = path.resolve(process.cwd(), 'data', '_shared', 'debates');
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

function ensureDir(): void {
  if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
  }
}

function buildFilename(chatId: number, specialistBotName: string, ts: number): string {
  return `${chatId}-${specialistBotName}-${ts}.json`;
}

/**
 * Specialist side: write a debate transcript to the shared dir.
 * Returns the absolute file path on success, null if write failed.
 */
export function writeTranscript(transcript: PersistedTranscript, logger?: pino.Logger): string | null {
  try {
    ensureDir();
    const ts = Date.now();
    const filename = buildFilename(transcript.chatId, transcript.specialistBotName, ts);
    const fullPath = path.join(SHARED_DIR, filename);
    fs.writeFileSync(fullPath, JSON.stringify(transcript, null, 2), 'utf8');
    return fullPath;
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'avengers.debateTransport: writeTranscript failed (debate result not persisted)',
    );
    return null;
  }
}

/**
 * Jarvis side: pick up the most recent transcript file matching this
 * chat + bot combination. Returns the parsed transcript and deletes the
 * file. Returns null if no matching file exists.
 *
 * The "match" is: same chatId AND same specialistBotName, written within
 * the last STALE_AFTER_MS window. If multiple match (specialist reposted),
 * picks the newest by mtime.
 */
export function consumeTranscript(
  chatId: number,
  specialistBotName: string,
  logger?: pino.Logger,
): PersistedTranscript | null {
  try {
    if (!fs.existsSync(SHARED_DIR)) return null;
    const prefix = `${chatId}-${specialistBotName}-`;
    const entries = fs
      .readdirSync(SHARED_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => {
        const fullPath = path.join(SHARED_DIR, f);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          // ignore stat errors
        }
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    if (entries.length === 0) return null;

    const newest = entries[0]!;
    const text = fs.readFileSync(newest.fullPath, 'utf8');
    let parsed: PersistedTranscript;
    try {
      parsed = JSON.parse(text) as PersistedTranscript;
    } catch (err) {
      logger?.warn(
        { path: newest.fullPath, err: err instanceof Error ? err.message : String(err) },
        'avengers.debateTransport: failed to parse transcript JSON; deleting',
      );
      try {
        fs.unlinkSync(newest.fullPath);
      } catch { /* best effort */ }
      return null;
    }

    // Delete the file so it's not picked up again.
    try {
      fs.unlinkSync(newest.fullPath);
    } catch (unlinkErr) {
      logger?.debug(
        { path: newest.fullPath, err: unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr) },
        'avengers.debateTransport: failed to delete transcript after consume (will be evicted)',
      );
    }

    // Also clean up any older matching files (specialist reposted within window).
    for (const entry of entries.slice(1)) {
      try {
        fs.unlinkSync(entry.fullPath);
      } catch { /* best effort */ }
    }

    return parsed;
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'avengers.debateTransport: consumeTranscript failed',
    );
    return null;
  }
}

/**
 * Belt-and-braces: sweep stale files older than STALE_AFTER_MS. Called
 * periodically from a scheduler tick to prevent the dir from accumulating
 * files when consumeTranscript misses a match (e.g., chat ID mismatch).
 */
export function evictStaleTranscripts(logger?: pino.Logger): { evicted: number } {
  let evicted = 0;
  try {
    if (!fs.existsSync(SHARED_DIR)) return { evicted: 0 };
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const f of fs.readdirSync(SHARED_DIR)) {
      const fullPath = path.join(SHARED_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          evicted++;
        }
      } catch {
        // ignore individual entry errors
      }
    }
  } catch (err) {
    logger?.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'avengers.debateTransport: evictStaleTranscripts non-fatal error',
    );
  }
  return { evicted };
}
