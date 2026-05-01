/**
 * botPathSandbox.ts — Per-bot path-sandbox narrowing (v1.21.0 ADR 021 D4 + CP1 R6).
 *
 * Narrows the allowed-path list from the config-wide build-dir root to the
 * per-bot `data/<botName>/` prefix for file-tool dispatchers (read_file,
 * write_file, list_directory, search_files).
 *
 * WHY at the safety layer (not just the tool dispatcher):
 *   A tool that bypasses the dispatcher (e.g., a future MCP server that reads
 *   files directly) inherits the safety layer's path check. Tool-level check
 *   alone is insufficient defense-in-depth (Anti-Slop §15).
 *
 * Per CP1 R6: run_command is NOT in the specialist tool allowlist, so there
 * is no need to gate shell commands here. The file-tool narrowing is sufficient.
 *
 * Usage:
 *   At boot, after resolveBotIdentity and before initSafety:
 *     const wrapped = wrapPathForBotIdentity(identity, cfg.filesystem.allowedPaths);
 *     cfg.filesystem.allowedPaths = wrapped; // or pass wrapped to initSafety
 *
 * For ai-jarvis (scope='full'): pass-through with the build-dir root replaced
 *   by data/ai-jarvis/.  Any project paths from config.projects are unchanged.
 * For ai-tony (scope='specialist'): replaced by data/ai-tony/.  Same project paths.
 *
 * Idempotent: calling twice returns the same result.
 */

import path from 'node:path';
import type { BotIdentity } from '../config/botIdentity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a path for comparison: lowercase + trailing-sep removal on Windows. */
function normPath(p: string): string {
  return p.toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * Determine if a path entry is the build-dir root or an unscoped data/ directory.
 * These are the entries we want to replace with the per-bot data path.
 *
 * Returns true if the entry is:
 *   - The build-dir root itself (process.cwd())
 *   - An unscoped data/ dir (e.g., data/ or data/anything NOT already per-bot)
 *
 * Entries that are already per-bot (data/ai-jarvis/, data/ai-tony/) are returned
 * as-is (idempotency).
 * Entries that are project paths outside the build dir are returned unchanged.
 */
function isBuildDirRootOrUnscopedData(
  entry: string,
  buildDir: string,
  dataDir: string,
): 'build-root' | 'unscoped-data' | 'scoped-data' | 'external' {
  const normEntry = normPath(entry);
  const normBuild = normPath(buildDir);
  const normData = normPath(dataDir);

  if (normEntry === normBuild) return 'build-root';

  // Already the correct per-bot data dir → idempotent
  if (normEntry === normData || normEntry.startsWith(normData + path.sep)) {
    return 'scoped-data';
  }

  // Unscoped data/ under the build dir: starts with <buildDir>/data
  const genericDataBase = normPath(path.join(buildDir, 'data'));
  if (normEntry === genericDataBase || normEntry.startsWith(genericDataBase + path.sep)) {
    return 'unscoped-data';
  }

  return 'external';
}

// ---------------------------------------------------------------------------
// wrapPathForBotIdentity
// ---------------------------------------------------------------------------

/**
 * Narrow the allowedPaths list so this bot process can only read/write its
 * own data directory, not other bots' data directories.
 *
 * Algorithm:
 *   1. For each entry in configAllowedPaths:
 *      - If it's the build-dir root → replace with identity.dataDir
 *      - If it's an unscoped data/ subdir → replace with identity.dataDir
 *      - If it's already the correct per-bot data dir → keep (idempotent)
 *      - Otherwise (external project path) → keep unchanged
 *   2. Deduplicate (a config that has BOTH the build-dir root AND an explicit
 *      data/ entry would otherwise produce two copies of identity.dataDir).
 *
 * @returns A new array — the original is not mutated.
 */
export function wrapPathForBotIdentity(
  identity: BotIdentity,
  configAllowedPaths: readonly string[],
): string[] {
  const buildDir = process.cwd();
  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of configAllowedPaths) {
    const classification = isBuildDirRootOrUnscopedData(entry, buildDir, identity.dataDir);

    let replacement: string;
    if (classification === 'external' || classification === 'scoped-data') {
      replacement = entry;
    } else {
      // 'build-root' or 'unscoped-data' → narrow to per-bot dataDir
      replacement = identity.dataDir;
    }

    const key = normPath(replacement);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(replacement);
    }
  }

  // v1.21.13 — append per-bot additionalReadPaths (resolved to absolute,
  // relative to the build dir). These are project-source paths that
  // specialist bots may read even though they're outside dataDir.
  for (const relPath of identity.additionalReadPaths) {
    const abs = path.resolve(buildDir, relPath);
    const key = normPath(abs);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(abs);
    }
  }

  return result;
}

/**
 * Check whether a given absolute path is within the bot's own data directory.
 *
 * Used by tools (read_file, write_file, list_directory, search_files) that want
 * to enforce the per-bot path-sandbox before invoking fs APIs.
 *
 * Returns `{ ok: true, sanitized }` on success, `{ ok: false, reason }` on rejection.
 *
 * Reasons:
 *   - EMPTY_PATH: empty or undefined input
 *   - ABSOLUTE_OUTSIDE_DATADIR: absolute path not under identity.dataDir
 *   - TRAVERSAL_REJECTED: path resolves outside identity.dataDir via `..`
 */
export function checkBotDataPath(
  identity: BotIdentity,
  requestedPath: string,
): { ok: true; sanitized: string } | { ok: false; reason: string } {
  if (!requestedPath || requestedPath.trim() === '') {
    return { ok: false, reason: 'EMPTY_PATH' };
  }

  // Resolve to absolute
  const abs = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(identity.dataDir, requestedPath);

  const normAbs = normPath(abs);
  const normBase = normPath(identity.dataDir);

  const isInside =
    normAbs === normBase || normAbs.startsWith(normBase + path.sep.toLowerCase());

  if (!isInside) {
    // Distinguish traversal (used relative `..`) from absolute outside
    if (path.isAbsolute(requestedPath)) {
      return { ok: false, reason: 'ABSOLUTE_OUTSIDE_DATADIR' };
    }
    return { ok: false, reason: 'TRAVERSAL_REJECTED' };
  }

  return { ok: true, sanitized: abs };
}
