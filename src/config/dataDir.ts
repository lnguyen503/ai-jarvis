import path from 'node:path';
import type { AppConfig } from './index.js';

/**
 * Resolve the project data directory from config. Sibling of memory.dbPath.
 * Falls back to './data' when no dbPath is set (test fixtures).
 *
 * Source of truth — DO NOT inline `path.dirname(memory.dbPath)` in command
 * files. v1.14.0 R2 (ADR 009 revisions): extracted from
 * src/commands/{organize,memory}.ts and the new src/webapp/itemsRoute.ts
 * to avoid drift. Three known call sites prior to v1.14.0; one going
 * forward.
 */
export function resolveDataDir(config: AppConfig): string {
  return path.resolve(config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data');
}
