/**
 * Coach log tools — five tool implementations for the autonomous coach agent (v1.18.0).
 *
 * ADR 018:
 *   Decision 14   — tool error contract: always { ok, ... }, never throws
 *   Decision 14.a — NUL-byte ban on all text fields (R5/F3 convergent; binding)
 *   Decision 14.b — recomputed per-field char caps (binding)
 *   Decision 14.d — audit detail: hash+length only; no raw body in audit rows
 *   Decision 3.a  — per-coach-turn caps: MAX_NUDGES=5, MAX_WRITES=10 (R3; binding)
 *
 * Dependency edges (binding per ADR 018 Decision 15):
 *   coachTools.ts → coach/coachMemory, coach/intensityTypes, tools/types, memory/auditLog,
 *                   organize/storage (readItem — verify itemId exists), safety (scrub)
 *   NO import from coach/index.ts.
 */

import { z } from 'zod';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeCoachEntry, readCoachEntries, COACH_EVENT_TYPES, isCoachEventType } from './coachMemory.js';
import type { CoachEventType } from './coachMemory.js';
import { isCoachIntensity } from './intensityTypes.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import type { AuditCategory } from '../memory/auditLog.js';
import { readItem } from '../organize/storage.js';

/** Derive the dataDir the same way organize_* tools do (mirrors organize_shared.ts). */
function getDataDir(ctx: ToolContext): string {
  return path.resolve(
    ctx.config.memory?.dbPath
      ? path.dirname(ctx.config.memory.dbPath)
      : 'data',
  );
}

// ---------------------------------------------------------------------------
// Per-field char caps (D14.b binding)
// ---------------------------------------------------------------------------

const MAX_NUDGE_TEXT = 1024;
const MAX_QUERY = 256;
const MAX_RESULT_DIGEST = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_URLS = 5;
const MAX_IDEA_SUMMARY = 1024;
const MAX_PLAN_SUMMARY = 2048;
const MAX_SUBTASK_COUNT = 50;

// Per-turn caps (D3.a binding)
const MAX_NUDGES_PER_TURN = 5;
const MAX_WRITES_PER_TURN = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * D14.a NUL-byte rejection.
 * Returns { ok: true } if the field is clean; { ok: false, code, error } if it contains NUL.
 *
 * @param fieldName  - Human-readable field name (used in the error message).
 * @param codePrefix - Uppercase SCREAMING_SNAKE prefix for the error code (e.g. 'NUDGE_TEXT').
 *                     Must NOT include trailing underscore.
 * @param value      - The string to check.
 */
function rejectNulBytes(fieldName: string, codePrefix: string, value: string): { ok: true } | { ok: false; code: string; error: string } { // ALLOWED: function parameter type, not an audit row
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
 * D14.d audit detail helper — hash + length only, no raw body.
 */
function hashAndLen(text: string): { hash: string; len: number } {
  return {
    hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    len: text.length,
  };
}

/**
 * Validate an organize itemId and verify it exists in storage.
 * Returns null if valid + found, or an error object.
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

/**
 * Common per-turn cap check for write tools.
 * Returns an error object if the cap is exceeded, null if the write is allowed.
 * Also checks nudge-specific cap when isNudge=true.
 */
function checkTurnCaps(
  ctx: ToolContext,
  isNudge: boolean,
): null | { code: string; message: string } {
  const counters = ctx.coachTurnCounters;
  if (!counters) return null; // non-coach context: no cap
  if (isNudge && counters.nudges >= MAX_NUDGES_PER_TURN) {
    return {
      code: 'NUDGE_CAP_EXCEEDED',
      message: `Coach turn nudge cap (${MAX_NUDGES_PER_TURN}) reached. Pick fewer items per run.`,
    };
  }
  if (counters.writes >= MAX_WRITES_PER_TURN) {
    return {
      code: 'MEMORY_WRITE_CAP_EXCEEDED',
      message: `Coach turn memory-write cap (${MAX_WRITES_PER_TURN}) reached. Per-turn budget exhausted.`,
    };
  }
  return null;
}

function incrementCounters(ctx: ToolContext, isNudge: boolean): void {
  const counters = ctx.coachTurnCounters;
  if (!counters) return;
  counters.writes++;
  if (isNudge) counters.nudges++;
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

// ---------------------------------------------------------------------------
// coach_log_nudge
// ---------------------------------------------------------------------------

const coachLogNudgeSchema = z.object({
  itemId: z.string().describe('Organize item ID this nudge is about.'),
  intensity: z.string().describe('CoachIntensity value: off | gentle | moderate | persistent'), // ALLOWED: docstring inside zod describe(), not an audit row
  nudgeText: z.string().max(MAX_NUDGE_TEXT).describe('The nudge message you will send to the user (≤1024 chars).'),
});

export const coachLogNudge: Tool<z.infer<typeof coachLogNudgeSchema>> = {
  name: 'coach_log_nudge',
  description:
    'Record a coach nudge for an organize item. Logs to keyed memory and emits a coach.nudge audit row (hash only — no raw text in audit).',
  parameters: coachLogNudgeSchema,
  async execute(input, ctx): Promise<ToolResult> {
    // D14.a NUL check
    const nulCheck = rejectNulBytes('nudgeText', 'NUDGE_TEXT', input.nudgeText);
    if (!nulCheck.ok) {
      return { ok: false, output: nulCheck.error, error: { code: nulCheck.code, message: nulCheck.error } };
    }
    // D14.b length check (belt-and-suspenders; zod already checks max)
    if (input.nudgeText.length > MAX_NUDGE_TEXT) {
      return { ok: false, output: `nudgeText too long (max ${MAX_NUDGE_TEXT} chars).`, error: { code: 'NUDGE_TOO_LONG', message: `nudgeText exceeds ${MAX_NUDGE_TEXT} chars.` } };
    }
    if (!isCoachIntensity(input.intensity)) {
      return { ok: false, output: `Invalid intensity "${input.intensity}".`, error: { code: 'INVALID_INTENSITY', message: `intensity must be one of: off, gentle, moderate, persistent.` } };
    }
    // D3.a turn caps
    const capErr = checkTurnCaps(ctx, true);
    if (capErr) return { ok: false, output: capErr.message, error: capErr };

    const itemErr = await resolveItemId(input.itemId, ctx);
    if (itemErr) return { ok: false, output: itemErr.message, error: itemErr };

    const scrubbedText = ctx.safety.scrub(input.nudgeText);
    try {
      await writeCoachEntry(
        ctx.userId!,
        getDataDir(ctx),
        input.itemId,
        'lastNudge',
        { intensity: input.intensity, nudgeText: scrubbedText },
        { safetyScrubber: ctx.safety.scrub.bind(ctx.safety) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: 'Memory write failed.', error: { code: 'MEMORY_WRITE_FAILED', message: msg } };
    }

    incrementCounters(ctx, true);

    // D14.d audit: hash + len only
    const { hash, len } = hashAndLen(scrubbedText);
    auditDetail('coach.nudge', ctx, {
      itemId: input.itemId,
      intensity: input.intensity,
      nudgeTextHash: hash,
      nudgeTextLen: len,
    });

    return { ok: true, output: `Nudge logged for item ${input.itemId} (intensity: ${input.intensity}).` };
  },
};

// ---------------------------------------------------------------------------
// coach_log_research
// ---------------------------------------------------------------------------

const coachLogResearchSchema = z.object({
  itemId: z.string(),
  query: z.string().max(MAX_QUERY).describe('Web search query (≤256 chars).'),
  resultDigest: z.string().max(MAX_RESULT_DIGEST).describe('Digest of the web content found (≤4096 chars).'),
  urls: z.array(z.string().max(MAX_URL_LENGTH)).max(MAX_URLS).describe('Up to 5 source URLs.'),
});

export const coachLogResearch: Tool<z.infer<typeof coachLogResearchSchema>> = {
  name: 'coach_log_research',
  description: 'Record a coach research result for an organize item.',
  parameters: coachLogResearchSchema,
  async execute(input, ctx): Promise<ToolResult> {
    // D14.a NUL checks
    for (const [field, codePrefix, value] of [
      ['query', 'QUERY', input.query],
      ['resultDigest', 'RESULT_DIGEST', input.resultDigest],
    ] as const) {
      const nulCheck = rejectNulBytes(field, codePrefix, value);
      if (!nulCheck.ok) {
        return { ok: false, output: nulCheck.error, error: { code: nulCheck.code, message: nulCheck.error } };
      }
    }
    if (input.query.length > MAX_QUERY) {
      return { ok: false, output: `query too long (max ${MAX_QUERY}).`, error: { code: 'QUERY_TOO_LONG', message: `query exceeds ${MAX_QUERY} chars.` } };
    }
    if (input.resultDigest.length > MAX_RESULT_DIGEST) {
      return { ok: false, output: `resultDigest too long (max ${MAX_RESULT_DIGEST}).`, error: { code: 'DIGEST_TOO_LONG', message: `resultDigest exceeds ${MAX_RESULT_DIGEST} chars.` } };
    }
    if (input.urls.length > MAX_URLS) {
      return { ok: false, output: `Too many URLs (max ${MAX_URLS}).`, error: { code: 'TOO_MANY_URLS', message: `URLs array exceeds ${MAX_URLS} entries.` } };
    }

    const capErr = checkTurnCaps(ctx, false);
    if (capErr) return { ok: false, output: capErr.message, error: capErr };

    const itemErr = await resolveItemId(input.itemId, ctx);
    if (itemErr) return { ok: false, output: itemErr.message, error: itemErr };

    const scrubbedDigest = ctx.safety.scrub(input.resultDigest);
    const scrubbedQuery = ctx.safety.scrub(input.query);
    try {
      await writeCoachEntry(
        ctx.userId!,
        getDataDir(ctx),
        input.itemId,
        'research',
        { query: scrubbedQuery, resultDigest: scrubbedDigest, urls: input.urls },
        { safetyScrubber: ctx.safety.scrub.bind(ctx.safety) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: 'Memory write failed.', error: { code: 'MEMORY_WRITE_FAILED', message: msg } };
    }

    incrementCounters(ctx, false);

    // D14.d audit: hashes + counts only
    auditDetail('coach.research', ctx, {
      itemId: input.itemId,
      queryHash: hashAndLen(scrubbedQuery).hash,
      resultDigestHash: hashAndLen(scrubbedDigest).hash,
      resultDigestLen: scrubbedDigest.length,
      urlCount: input.urls.length,
    });

    return { ok: true, output: `Research logged for item ${input.itemId} (${input.urls.length} url(s)).` };
  },
};

// ---------------------------------------------------------------------------
// coach_log_idea
// ---------------------------------------------------------------------------

const coachLogIdeaSchema = z.object({
  itemId: z.string(),
  ideaSummary: z.string().max(MAX_IDEA_SUMMARY).describe('Original idea or suggestion (≤1024 chars).'),
});

export const coachLogIdea: Tool<z.infer<typeof coachLogIdeaSchema>> = {
  name: 'coach_log_idea',
  description: 'Record an original idea the coach proposed for an organize item.',
  parameters: coachLogIdeaSchema,
  async execute(input, ctx): Promise<ToolResult> {
    const nulCheck = rejectNulBytes('ideaSummary', 'IDEA_SUMMARY', input.ideaSummary);
    if (!nulCheck.ok) {
      return { ok: false, output: nulCheck.error, error: { code: nulCheck.code, message: nulCheck.error } };
    }
    if (input.ideaSummary.length > MAX_IDEA_SUMMARY) {
      return { ok: false, output: `ideaSummary too long (max ${MAX_IDEA_SUMMARY}).`, error: { code: 'IDEA_TOO_LONG', message: `ideaSummary exceeds ${MAX_IDEA_SUMMARY} chars.` } };
    }

    const capErr = checkTurnCaps(ctx, false);
    if (capErr) return { ok: false, output: capErr.message, error: capErr };

    const itemErr = await resolveItemId(input.itemId, ctx);
    if (itemErr) return { ok: false, output: itemErr.message, error: itemErr };

    const scrubbed = ctx.safety.scrub(input.ideaSummary);
    try {
      await writeCoachEntry(
        ctx.userId!,
        getDataDir(ctx),
        input.itemId,
        'idea',
        { ideaSummary: scrubbed },
        { safetyScrubber: ctx.safety.scrub.bind(ctx.safety) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: 'Memory write failed.', error: { code: 'MEMORY_WRITE_FAILED', message: msg } };
    }

    incrementCounters(ctx, false);

    const { hash, len } = hashAndLen(scrubbed);
    auditDetail('coach.idea', ctx, {
      itemId: input.itemId,
      ideaSummaryHash: hash,
      ideaSummaryLen: len,
    });

    return { ok: true, output: `Idea logged for item ${input.itemId}.` };
  },
};

// ---------------------------------------------------------------------------
// coach_log_plan
// ---------------------------------------------------------------------------

const coachLogPlanSchema = z.object({
  itemId: z.string(),
  planSummary: z.string().max(MAX_PLAN_SUMMARY).describe('Task breakdown or plan (≤2048 chars).'),
  subtaskCount: z.number().int().min(0).max(MAX_SUBTASK_COUNT).describe('Number of subtasks in the plan (0..50).'),
});

export const coachLogPlan: Tool<z.infer<typeof coachLogPlanSchema>> = {
  name: 'coach_log_plan',
  description: 'Record a task breakdown plan for an organize item.',
  parameters: coachLogPlanSchema,
  async execute(input, ctx): Promise<ToolResult> {
    const nulCheck = rejectNulBytes('planSummary', 'PLAN_SUMMARY', input.planSummary);
    if (!nulCheck.ok) {
      return { ok: false, output: nulCheck.error, error: { code: nulCheck.code, message: nulCheck.error } };
    }
    if (input.planSummary.length > MAX_PLAN_SUMMARY) {
      return { ok: false, output: `planSummary too long (max ${MAX_PLAN_SUMMARY}).`, error: { code: 'PLAN_TOO_LONG', message: `planSummary exceeds ${MAX_PLAN_SUMMARY} chars.` } };
    }
    if (!Number.isInteger(input.subtaskCount) || input.subtaskCount < 0 || input.subtaskCount > MAX_SUBTASK_COUNT) {
      return { ok: false, output: `subtaskCount must be an integer 0..${MAX_SUBTASK_COUNT}.`, error: { code: 'INVALID_SUBTASK_COUNT', message: `subtaskCount out of range 0..${MAX_SUBTASK_COUNT}.` } };
    }

    const capErr = checkTurnCaps(ctx, false);
    if (capErr) return { ok: false, output: capErr.message, error: capErr };

    const itemErr = await resolveItemId(input.itemId, ctx);
    if (itemErr) return { ok: false, output: itemErr.message, error: itemErr };

    const scrubbed = ctx.safety.scrub(input.planSummary);
    try {
      await writeCoachEntry(
        ctx.userId!,
        getDataDir(ctx),
        input.itemId,
        'plan',
        { planSummary: scrubbed, subtaskCount: input.subtaskCount },
        { safetyScrubber: ctx.safety.scrub.bind(ctx.safety) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: 'Memory write failed.', error: { code: 'MEMORY_WRITE_FAILED', message: msg } };
    }

    incrementCounters(ctx, false);

    const { hash, len } = hashAndLen(scrubbed);
    auditDetail('coach.plan', ctx, {
      itemId: input.itemId,
      planSummaryHash: hash,
      planSummaryLen: len,
      subtaskCount: input.subtaskCount,
    });

    return { ok: true, output: `Plan logged for item ${input.itemId} (${input.subtaskCount} subtask(s)).` };
  },
};

// ---------------------------------------------------------------------------
// coach_read_history
// ---------------------------------------------------------------------------

const coachReadHistorySchema = z.object({
  itemId: z.string().describe('Organize item ID to read history for.'),
  eventType: z
    .enum(COACH_EVENT_TYPES)
    .optional()
    .describe('Filter to a specific event type. Omit to read all.'),
  limit: z.number().int().min(1).max(30).default(10).describe('Max entries to return (1..30, default 10).'),
});

export const coachReadHistory: Tool<z.infer<typeof coachReadHistorySchema>> = {
  name: 'coach_read_history',
  description:
    'Read coach memory history for an organize item. Returns recent entries sorted newest-first. Does NOT count against per-turn write caps.',
  parameters: coachReadHistorySchema,
  async execute(input, ctx): Promise<ToolResult> {
    // Validate itemId format (don't need to verify it exists — user may be reading history for a deleted item)
    if (typeof input.itemId !== 'string' || input.itemId.trim().length === 0) {
      return { ok: false, output: 'itemId must be a non-empty string.', error: { code: 'INVALID_ITEM_ID', message: 'itemId must be a non-empty string.' } };
    }
    if (input.eventType !== undefined && !isCoachEventType(input.eventType)) {
      return { ok: false, output: `Invalid eventType "${input.eventType}".`, error: { code: 'INVALID_EVENT_TYPE', message: `eventType must be one of: ${COACH_EVENT_TYPES.join(', ')}.` } };
    }
    const limit = input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      return { ok: false, output: 'limit must be 1..30.', error: { code: 'LIMIT_OUT_OF_RANGE', message: 'limit must be an integer between 1 and 30.' } };
    }

    const userId = ctx.userId;
    if (!userId) {
      return { ok: false, output: 'No userId in context.', error: { code: 'INVALID_ITEM_ID', message: 'No userId in context.' } };
    }

    const prefix = input.eventType
      ? `coach.${input.itemId}.${input.eventType}.`
      : `coach.${input.itemId}.`;

    const entries = await readCoachEntries(userId, getDataDir(ctx), prefix, limit);

    const output = entries.length === 0
      ? `No coach history found for item ${input.itemId}${input.eventType ? ` (${input.eventType})` : ''}.`
      : entries
          .map((e) => `[${e.at}] ${e.eventType}: ${JSON.stringify(e.payload)}`)
          .join('\n');

    return {
      ok: true,
      output,
      data: { entries: entries.map((e) => ({ at: e.at, eventType: e.eventType, payload: e.payload })) },
    };
  },
};

// ---------------------------------------------------------------------------
// Re-exported constants (for tests and tools/index.ts registration)
// ---------------------------------------------------------------------------

export const COACH_TOOL_NAMES = [
  'coach_log_nudge',
  'coach_log_research',
  'coach_log_idea',
  'coach_log_plan',
  'coach_read_history',
] as const;

export type CoachToolName = (typeof COACH_TOOL_NAMES)[number];

export { MAX_NUDGE_TEXT, MAX_QUERY, MAX_RESULT_DIGEST, MAX_URL_LENGTH, MAX_URLS, MAX_IDEA_SUMMARY, MAX_PLAN_SUMMARY, MAX_SUBTASK_COUNT, MAX_NUDGES_PER_TURN, MAX_WRITES_PER_TURN };
export type { CoachEventType };
