/**
 * Coach override tools — coachOverrideTool.ts (v1.19.0 commit 4b).
 *
 * Implements:
 *   - coach_log_user_override — writes a user NL override keyed memory entry
 *     (sole-writer chain; NUL ban; per-field char caps; per-turn cap; audit)
 *
 * Future (v1.19.0 D10 — commit filled in later):
 *   - coach_clear_override — clears a stored user override entry
 *
 * This file is the pre-emptive split from coachTools.ts (ADR 019 commit 0d / W1).
 * coachTools.ts projected to cross 500 LOC after these additions.
 *
 * Dependency edges (binding per ADR 018 Decision 15 + ADR 019 R3):
 *   coachOverrideTool.ts → coach/coachMemory, tools/types, memory/auditLog,
 *                          organize/storage (readItem — verify itemId exists),
 *                          safety (scrub)
 *   NO import from coach/index.ts or agent/*.
 *
 * ADR 019 R3/W1 + F3 (closed-set audit categories).
 * ADR 019 revisions-after-cp1 Decision 21 (R1/F1 convergent — sole-writer + validators).
 *
 * Privacy posture (ADR 019 F3):
 *   Detail JSON carries STRUCTURAL metadata only — NO raw fromMessage content.
 *   Detail shape: { itemId, intent, expiresAtIso, fuzzyScore }.
 */

import { z } from 'zod';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEntry, updateEntry, getEntry } from '../memory/userMemoryEntries.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import type { AuditCategory } from '../memory/auditLog.js';
import { readItem } from '../organize/storage.js';

/** Derive the dataDir the same way organize_* and coachTools.ts do. */
function getDataDir(ctx: ToolContext): string {
  return path.resolve(
    ctx.config.memory?.dbPath
      ? path.dirname(ctx.config.memory.dbPath)
      : 'data',
  );
}

// ---------------------------------------------------------------------------
// Per-field char caps (ADR 019 R3 binding — mirrors coachTools.ts D14.b)
// ---------------------------------------------------------------------------

/** Maximum characters allowed in fromMessage field (ADR 019 R3). */
const MAX_FROM_MESSAGE = 500;
/** Maximum characters for expiry ISO string (standard ISO 8601 length ~24). */
const MAX_EXPIRES_AT_ISO = 50;

// Per-turn caps (from coachTools.ts; binding)
const MAX_WRITES_PER_TURN = 10;

// ---------------------------------------------------------------------------
// Valid intent kinds (mirrors OverrideIntentKind in userOverrideParser.ts)
// ---------------------------------------------------------------------------

const OVERRIDE_INTENT_KINDS = ['back_off', 'push', 'defer', 'done_signal'] as const;
type OverrideIntentKind = typeof OVERRIDE_INTENT_KINDS[number];

function isOverrideIntentKind(value: unknown): value is OverrideIntentKind { // ALLOWED: function parameter type guard — not an audit detail field
  return typeof value === 'string' && (OVERRIDE_INTENT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from coachTools.ts — single-implementation guard)
// ---------------------------------------------------------------------------

/**
 * D14.a NUL-byte rejection (binding from coachTools.ts; mirrors rejectNulBytes).
 */
function rejectNulBytes(
  fieldName: string,
  codePrefix: string,
  value: string, // ALLOWED: function parameter — not an audit detail field
): { ok: true } | { ok: false; code: string; error: string } {
  if (value.includes('\x00')) {
    return {
      ok: false,
      code: `${codePrefix}_INVALID_CHARS`,
      error: `Field "${fieldName}" cannot contain null bytes.`,
    };
  }
  return { ok: true };
}

/**
 * Common per-turn cap check for write tools (mirrors coachTools.ts checkTurnCaps).
 */
function checkWriteCap(ctx: ToolContext): null | { code: string; message: string } {
  const counters = ctx.coachTurnCounters;
  if (!counters) return null; // non-coach context: no cap
  if (counters.writes >= MAX_WRITES_PER_TURN) {
    return {
      code: 'MEMORY_WRITE_CAP_EXCEEDED',
      message: `Coach turn memory-write cap (${MAX_WRITES_PER_TURN}) reached. Per-turn budget exhausted.`,
    };
  }
  return null;
}

function incrementWriteCounter(ctx: ToolContext): void {
  const counters = ctx.coachTurnCounters;
  if (!counters) return;
  counters.writes++;
}

function auditDetail(
  category: AuditCategory,
  ctx: ToolContext,
  detail: Record<string, unknown>,
): void {
  ctx.memory.auditLog.insert({
    category,
    actor_user_id: ctx.userId ?? null,
    actor_chat_id: ctx.chatId,
    session_id: ctx.sessionId,
    detail,
  });
}

/**
 * Validate an organize itemId and verify it exists in storage.
 */
async function resolveItemId(
  itemId: unknown,
  ctx: ToolContext,
): Promise<null | { code: string; message: string }> {
  if (typeof itemId !== 'string' || itemId.trim().length === 0) {
    return { code: 'INVALID_ITEM_ID', message: 'itemId must be a non-empty string.' };
  }
  const userId = ctx.userId;
  if (!userId) {
    return { code: 'INVALID_ITEM_ID', message: 'No userId in context; coach tools require a DM session.' };
  }
  const item = await readItem(userId, getDataDir(ctx), itemId.trim());
  if (!item) {
    return { code: 'ITEM_NOT_FOUND', message: `Organize item "${itemId}" not found for user.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// coach_log_user_override
// ---------------------------------------------------------------------------

const coachLogUserOverrideSchema = z.object({
  itemId: z.string().describe('Organize item ID this override applies to.'),
  intent: z.enum(OVERRIDE_INTENT_KINDS).describe(
    'Override intent: back_off | push | defer | done_signal.',
  ),
  fromMessage: z
    .string()
    .max(MAX_FROM_MESSAGE)
    .describe('Original user message that triggered this override (≤500 chars; for audit).'),
  expiresAtIso: z
    .string()
    .max(MAX_EXPIRES_AT_ISO)
    .describe('ISO 8601 expiry timestamp for this override. Use now+7d for back_off, now+1d for defer, now (single-run) for push/done_signal.'),
});

export const coachLogUserOverride: Tool<z.infer<typeof coachLogUserOverrideSchema>> = {
  name: 'coach_log_user_override',
  description:
    'Record a user NL override for an organize item (back_off / push / defer / done_signal). ' +
    'Writes to keyed memory coach.<itemId>.userOverride. Audits as coach.user_override. ' +
    'Callable in: coach turns (isCoachRun=true) and explicit /coach back-off|push|defer commands. ' +
    'NOT callable from arbitrary chat turns (not auto-invoked by agent.turn). ' +
    'ADR 019 R3 — sole-writer chain; NUL ban; per-field char caps; per-turn write cap.',
  parameters: coachLogUserOverrideSchema,
  async execute(input, ctx): Promise<ToolResult> {
    // D14.a NUL checks
    for (const [field, prefix, value] of [
      ['fromMessage', 'FROM_MESSAGE', input.fromMessage],
      ['expiresAtIso', 'EXPIRES_AT', input.expiresAtIso],
    ] as const) {
      const nulCheck = rejectNulBytes(field, prefix, value);
      if (!nulCheck.ok) {
        return {
          ok: false,
          output: nulCheck.error,
          error: { code: nulCheck.code, message: nulCheck.error },
        };
      }
    }

    // D14.b length checks (belt-and-suspenders; zod already checks max)
    if (input.fromMessage.length > MAX_FROM_MESSAGE) {
      return {
        ok: false,
        output: `fromMessage too long (max ${MAX_FROM_MESSAGE} chars).`,
        error: { code: 'FROM_MESSAGE_TOO_LONG', message: `fromMessage exceeds ${MAX_FROM_MESSAGE} chars.` },
      };
    }

    // Intent validation (belt-and-suspenders; zod .enum already validates)
    if (!isOverrideIntentKind(input.intent)) {
      return {
        ok: false,
        output: `Invalid intent "${input.intent}". Must be one of: ${OVERRIDE_INTENT_KINDS.join(', ')}.`,
        error: { code: 'INVALID_INTENT', message: `intent must be one of: ${OVERRIDE_INTENT_KINDS.join(', ')}.` },
      };
    }

    // Per-turn cap (coach context only — chat-side calls don't gate per v1.18.0 R3 invariant 5)
    const capErr = checkWriteCap(ctx);
    if (capErr) {
      return { ok: false, output: capErr.message, error: capErr };
    }

    // Verify itemId exists
    const itemErr = await resolveItemId(input.itemId, ctx);
    if (itemErr) {
      return { ok: false, output: itemErr.message, error: itemErr };
    }

    const userId = ctx.userId!;
    const dataDir = getDataDir(ctx);
    const key = `coach.${input.itemId.trim()}.userOverride`;

    // Build the body: scrub fromMessage before storing // ALLOWED: variable name 'body' in comment — not an audit detail field
    const scrubbedFromMessage = ctx.safety.scrub(input.fromMessage);
    const body = JSON.stringify({
      intent: input.intent,
      expiresAtIso: input.expiresAtIso,
      fromMessageHash: createHash('sha256').update(scrubbedFromMessage).digest('hex').slice(0, 16),
      fromMessageLen: scrubbedFromMessage.length,
      recordedAt: new Date().toISOString(),
    });

    // Upsert: update if exists, create if not
    const existing = await getEntry(userId, dataDir, key);
    let writeResult: { ok: boolean; code?: string };
    if (existing) {
      writeResult = await updateEntry(userId, dataDir, key, body);
    } else {
      writeResult = await createEntry(userId, dataDir, key, body);
    }

    if (!writeResult.ok) {
      return {
        ok: false,
        output: 'Memory write failed.',
        error: {
          code: 'MEMORY_WRITE_FAILED',
          message: `coach_log_user_override: write failed — code=${writeResult.code ?? 'UNKNOWN'}`,
        },
      };
    }

    // Increment per-turn counter (only in coach turns; checkWriteCap already guards)
    incrementWriteCounter(ctx);

    // D14.d audit: structural metadata only — NO raw fromMessage content
    auditDetail('coach.user_override', ctx, {
      itemId: input.itemId.trim(),
      intent: input.intent,
      expiresAtIso: input.expiresAtIso,
      fromMessageLen: scrubbedFromMessage.length,
    });

    return {
      ok: true,
      output: `User override logged for item ${input.itemId} (intent: ${input.intent}, expires: ${input.expiresAtIso}).`,
    };
  },
};

// ---------------------------------------------------------------------------
// Placeholder: coach_clear_override (ADR 019 D10 — filled in later)
// ---------------------------------------------------------------------------

export const COACH_OVERRIDE_TOOL_PLACEHOLDER = 'coach_override_tool_placeholder' as const;

// ---------------------------------------------------------------------------
// Re-exports for tools/index.ts registration
// ---------------------------------------------------------------------------

export const COACH_OVERRIDE_TOOL_NAMES = [
  'coach_log_user_override',
] as const;

export type CoachOverrideToolName = (typeof COACH_OVERRIDE_TOOL_NAMES)[number];
