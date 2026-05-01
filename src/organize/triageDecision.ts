/**
 * Triage LLM output schema + parser (v1.9.0).
 *
 * Exports:
 *   TriageOutputSchema — zod discriminated union for the LLM's JSON reply
 *   TriageDecision     — inferred TypeScript type
 *   parseTriageDecision(raw, pickedItemIds) — robust parser; returns null on any failure
 *
 * Design: NEVER throw. Always return null on any parse/validation/hallucination
 * failure. The caller (reminders.ts) logs what went wrong via log.warn.
 *
 * Extra fields: schema uses .strip() (zod default passthrough is not used) — any
 * extraneous field in the LLM output is silently stripped rather than failing
 * validation. This is deliberate: LLMs frequently add fields like `explanation`
 * even when instructed not to; we ignore them rather than rejecting the whole
 * response. The test suite documents this choice.
 *
 * See ARCHITECTURE.md §17.5 and ADR 004 §5.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const TriageOutputSchema = z.discriminatedUnion('shouldNudge', [
  z.object({
    shouldNudge: z.literal(false),
    reasoning: z.string().max(300),
  }),
  z.object({
    shouldNudge: z.literal(true),
    itemId: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/),
    urgency: z.enum(['low', 'medium', 'high']),
    message: z.string().min(1).max(280),
    offer: z
      .object({
        kind: z.enum(['none', 'snooze', 'complete', 'list', 'search', 'update', 'other']),
        description: z.string().max(140),
      })
      .optional(),
    reasoning: z.string().max(300),
  }),
]);

export type TriageDecision = z.infer<typeof TriageOutputSchema>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw LLM response string into a TriageDecision.
 *
 * Steps:
 *  1. Strip markdown fences (```json ... ```)
 *  2. Extract first { ... last } to handle leading/trailing prose
 *  3. JSON.parse — null on SyntaxError
 *  4. Zod validation — null on failure
 *  5. Hallucination defense: if shouldNudge:true, itemId must be in pickedItemIds — null if not
 *
 * Returns null on ANY failure. Never throws.
 *
 * @param raw          - Raw string from the LLM provider
 * @param pickedItemIds - The ids of the items actually included in the triage input
 */
export function parseTriageDecision(
  raw: string,
  pickedItemIds: string[],
): TriageDecision | null {
  if (!raw || typeof raw !== 'string') return null;

  // Step 1: strip markdown fences
  // Handles ```json\n...\n``` or ``` ... ```
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1]?.trim() ?? '';
  }

  // Step 2: extract first { ... last } (handles leading/trailing prose)
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  text = text.slice(firstBrace, lastBrace + 1);

  // Step 3: JSON.parse
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }

  // Step 4: Zod validation
  const result = TriageOutputSchema.safeParse(obj);
  if (!result.success) return null;

  const decision = result.data;

  // Step 5: Hallucination defense
  if (decision.shouldNudge === true) {
    if (!pickedItemIds.includes(decision.itemId)) {
      return null;
    }
  }

  return decision;
}
