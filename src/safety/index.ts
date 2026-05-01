/** Safety module: path sandbox, command blocklist, output scrubber, and confirmation-flow manager — all safety checks go through SafetyApi. */

import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { BotIdentity } from '../config/botIdentity.js';
import { PathSandbox } from './paths.js';
import { CommandClassifier, type ClassifyResult } from './blocklist.js';
import { scrub, scrubRecord } from './scrubber.js';
import { ConfirmationManager, type PendingAction, type RequireConfirmationResult } from './confirmations.js';
import { wrapPathForBotIdentity } from './botPathSandbox.js';

export type { ClassifyResult, PendingAction, RequireConfirmationResult };

export interface SafetyApi {
  /** US-4, C1 — realpath+NFC+casefold+sep-boundary */
  isPathAllowed(absPath: string): boolean;
  /** C7/C10 — path allowed AND not in readDenyGlobs */
  isReadAllowed(absPath: string): boolean;
  /** F-01 — path allowed AND not in write denylist (.env, *.db, logs/*, data/*) */
  isWriteAllowed(absPath: string): boolean;
  /** v1.7.5 — session-scoped path check, for per-chat workspace isolation */
  isPathAllowedInRoots(absPath: string, roots: readonly string[]): boolean;
  isReadAllowedInRoots(absPath: string, roots: readonly string[]): boolean;
  isWriteAllowedInRoots(absPath: string, roots: readonly string[]): boolean;
  /** Filter directory listing to exclude denied entries */
  filterDeniedEntries(dirPath: string, entries: string[]): string[];
  /** US-6, C2, W6 — normalize+tokenize+shape-match */
  classifyCommand(
    cmd: string,
    shell: 'powershell' | 'cmd' | 'none',
  ): ClassifyResult;
  /** Require user confirmation for a destructive action */
  requireConfirmation(
    sessionId: number,
    pending: Omit<PendingAction, 'actionId' | 'enqueuedAt'>,
  ): RequireConfirmationResult;
  /** Attempt to consume a pending confirmation */
  consumeConfirmation(sessionId: number, userText: string, nowMs?: number): PendingAction | null;
  /** Check if a session has an active pending confirmation */
  hasPending(sessionId: number): boolean;
  /** C7/C8 — secret scrubber */
  scrub(text: string): string;
  /** Scrub a data record's string values */
  scrubRecord(data: Record<string, unknown>): Record<string, unknown>;
}

/**
 * v1.7.5 — per-session safety shim. Wraps the base SafetyApi but overrides
 * the three path-check methods to use the session's effective allowedRoots
 * instead of the config-wide list. Used so a developer in a group sees only
 * that group's workspace.
 *
 * Everything else (classifyCommand, scrub, confirmations) is pass-through.
 */
export function sessionSafety(base: SafetyApi, effectiveRoots: readonly string[]): SafetyApi {
  return {
    ...base,
    isPathAllowed(absPath) {
      return base.isPathAllowedInRoots(absPath, effectiveRoots);
    },
    isReadAllowed(absPath) {
      return base.isReadAllowedInRoots(absPath, effectiveRoots);
    },
    isWriteAllowed(absPath) {
      return base.isWriteAllowedInRoots(absPath, effectiveRoots);
    },
    filterDeniedEntries(dirPath, entries) {
      return entries.filter((e) =>
        base.isReadAllowedInRoots(`${dirPath}\\${e}`, effectiveRoots) ||
        base.isReadAllowedInRoots(`${dirPath}/${e}`, effectiveRoots),
      );
    },
  };
}

/**
 * Initialize the safety subsystem.
 * Returns a SafetyApi that combines path sandbox, blocklist, scrubber, and confirmations.
 *
 * v1.21.0 ADR 021 D4 + Scalability CRITICAL-1.21.0.A: when `identity` is supplied,
 * `cfg.filesystem.allowedPaths` is narrowed via `wrapPathForBotIdentity` BEFORE the
 * PathSandbox is constructed. This ensures every read_file/write_file/list_directory/
 * search_files call is gated by the per-bot data dir at the safety layer (defense-
 * in-depth — the dispatcher gate alone is insufficient since future MCP servers may
 * read files directly without going through the dispatcher).
 *
 * Without `identity`, the legacy single-bot behavior is preserved (full
 * `cfg.filesystem.allowedPaths`).
 */
export function initSafety(
  cfg: AppConfig,
  memory: MemoryApi,
  identity?: BotIdentity,
): SafetyApi {
  // v1.21.0 D4 — per-bot path narrowing. When identity is present, replace the
  // build-dir root and any unscoped data/ entries with identity.dataDir.
  // Mutates a shallow copy of cfg.filesystem so the original config is unchanged.
  const effectiveCfg: AppConfig = identity
    ? {
        ...cfg,
        filesystem: {
          ...cfg.filesystem,
          allowedPaths: wrapPathForBotIdentity(identity, cfg.filesystem.allowedPaths),
        },
      }
    : cfg;

  const pathSandbox = new PathSandbox(effectiveCfg);
  const classifier = new CommandClassifier(effectiveCfg);
  const confirmations = new ConfirmationManager(effectiveCfg, memory);

  return {
    isPathAllowed(absPath: string): boolean {
      return pathSandbox.isPathAllowed(absPath);
    },

    isReadAllowed(absPath: string): boolean {
      return pathSandbox.isReadAllowed(absPath);
    },

    isWriteAllowed(absPath: string): boolean {
      return pathSandbox.isWriteAllowed(absPath);
    },

    isPathAllowedInRoots(absPath: string, roots: readonly string[]): boolean {
      return pathSandbox.isPathAllowedInRoots(absPath, roots);
    },
    isReadAllowedInRoots(absPath: string, roots: readonly string[]): boolean {
      return pathSandbox.isReadAllowedInRoots(absPath, roots);
    },
    isWriteAllowedInRoots(absPath: string, roots: readonly string[]): boolean {
      return pathSandbox.isWriteAllowedInRoots(absPath, roots);
    },

    filterDeniedEntries(dirPath: string, entries: string[]): string[] {
      return pathSandbox.filterDeniedEntries(dirPath, entries);
    },

    classifyCommand(cmd: string, shell: 'powershell' | 'cmd' | 'none'): ClassifyResult {
      return classifier.classifyCommand(cmd, shell);
    },

    requireConfirmation(
      sessionId: number,
      pending: Omit<PendingAction, 'actionId' | 'enqueuedAt'>,
    ): RequireConfirmationResult {
      return confirmations.requireConfirmation(sessionId, pending);
    },

    consumeConfirmation(sessionId: number, userText: string, nowMs?: number): PendingAction | null {
      return confirmations.consumeConfirmation(sessionId, userText, nowMs);
    },

    hasPending(sessionId: number): boolean {
      return confirmations.hasPending(sessionId);
    },

    scrub(text: string): string {
      return scrub(text);
    },

    scrubRecord(data: Record<string, unknown>): Record<string, unknown> {
      return scrubRecord(data);
    },
  };
}
