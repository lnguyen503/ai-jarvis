/**
 * Shared zod schemas and helpers for organize_* tools (v1.8.6).
 *
 * Centralised here so the 6 tool files don't duplicate schema definitions.
 * These schemas match the contracts in ARCHITECTURE.md §16.3.1.
 */

import { z } from 'zod';
import path from 'node:path';
import type { ToolContext } from './types.js';

// ---------------------------------------------------------------------------
// Shared zod schemas
// ---------------------------------------------------------------------------

export const OrganizeTypeSchema = z.enum(['task', 'event', 'goal']);
export const OrganizeStatusSchema = z.enum(['active', 'done', 'abandoned']);

export const ItemIdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/, 'itemId must be YYYY-MM-DD-xxxx');

export const TagListSchema = z
  .array(z.string().min(1).max(40))
  .max(10)
  .optional();

// ---------------------------------------------------------------------------
// dataDir helper — mirrors update_memory.ts lines 104-106
// ---------------------------------------------------------------------------

export function getDataDir(ctx: ToolContext): string {
  return path.resolve(
    ctx.config.memory?.dbPath
      ? path.dirname(ctx.config.memory.dbPath)
      : 'data',
  );
}
