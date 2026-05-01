/**
 * Tests for src/organize/triageDecision.ts (§17.15.2)
 */

import { describe, expect, it } from 'vitest';
import { parseTriageDecision, TriageOutputSchema } from '../../src/organize/triageDecision.js';

// Helpers
const VALID_ITEM_ID = '2026-04-24-ab12';
const PICKED_IDS = [VALID_ITEM_ID, '2026-04-24-cd34'];

function makeFalseDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    shouldNudge: false,
    reasoning: 'All good',
    ...overrides,
  });
}

function makeTrueDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    shouldNudge: true,
    itemId: VALID_ITEM_ID,
    urgency: 'medium',
    message: 'Time to check on your task!',
    reasoning: 'Due date is close',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// TriageOutputSchema — direct validation tests
// ---------------------------------------------------------------------------

describe('TriageOutputSchema — valid shouldNudge:false', () => {
  it('accepts minimal shouldNudge:false', () => {
    const result = TriageOutputSchema.safeParse({ shouldNudge: false, reasoning: 'ok' });
    expect(result.success).toBe(true);
  });

  it('accepts reasoning at exactly 300 chars', () => {
    const result = TriageOutputSchema.safeParse({ shouldNudge: false, reasoning: 'x'.repeat(300) });
    expect(result.success).toBe(true);
  });

  it('rejects reasoning > 300 chars', () => {
    const result = TriageOutputSchema.safeParse({ shouldNudge: false, reasoning: 'x'.repeat(301) });
    expect(result.success).toBe(false);
  });
});

describe('TriageOutputSchema — valid shouldNudge:true', () => {
  it('accepts full valid shouldNudge:true', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: VALID_ITEM_ID,
      urgency: 'high',
      message: 'Your event is in 1 hour!',
      offer: { kind: 'none', description: '' },
      reasoning: 'Event imminent',
    });
    expect(result.success).toBe(true);
  });

  it('accepts shouldNudge:true without offer (optional)', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: VALID_ITEM_ID,
      urgency: 'low',
      message: 'Gentle reminder about your goal.',
      reasoning: 'Goal is overdue',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing message', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: VALID_ITEM_ID,
      urgency: 'medium',
      reasoning: 'Due today',
    });
    expect(result.success).toBe(false);
  });

  it('rejects message > 280 chars', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: VALID_ITEM_ID,
      urgency: 'medium',
      message: 'x'.repeat(281),
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty message', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: VALID_ITEM_ID,
      urgency: 'medium',
      message: '',
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid urgency value', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: VALID_ITEM_ID,
      urgency: 'critical', // not in enum
      message: 'test msg',
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects itemId not matching pattern', () => {
    const result = TriageOutputSchema.safeParse({
      shouldNudge: true,
      itemId: 'not-a-valid-id',
      urgency: 'low',
      message: 'test',
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTriageDecision — core parser
// ---------------------------------------------------------------------------

describe('parseTriageDecision — valid shouldNudge:false', () => {
  it('parses valid JSON', () => {
    const result = parseTriageDecision(makeFalseDecision(), PICKED_IDS);
    expect(result).not.toBeNull();
    expect(result?.shouldNudge).toBe(false);
  });
});

describe('parseTriageDecision — valid shouldNudge:true', () => {
  it('parses valid shouldNudge:true decision', () => {
    const result = parseTriageDecision(makeTrueDecision(), PICKED_IDS);
    expect(result).not.toBeNull();
    expect(result?.shouldNudge).toBe(true);
    if (result?.shouldNudge) {
      expect(result.itemId).toBe(VALID_ITEM_ID);
      expect(result.urgency).toBe('medium');
    }
  });

  it('parses with optional offer', () => {
    const raw = makeTrueDecision({
      offer: { kind: 'complete', description: 'Want me to mark this done?' },
    });
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
    if (result?.shouldNudge) {
      expect(result.offer?.kind).toBe('complete');
    }
  });
});

describe('parseTriageDecision — markdown fences stripped', () => {
  it('strips ```json ... ``` fences', () => {
    const raw = '```json\n' + makeFalseDecision() + '\n```';
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
    expect(result?.shouldNudge).toBe(false);
  });

  it('strips plain ``` ... ``` fences', () => {
    const raw = '```\n' + makeFalseDecision() + '\n```';
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
  });
});

describe('parseTriageDecision — leading prose stripped', () => {
  it('extracts JSON from text with leading prose', () => {
    const raw = 'Here is my decision: ' + makeTrueDecision() + ' Hope that helps.';
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
    expect(result?.shouldNudge).toBe(true);
  });
});

describe('parseTriageDecision — null on failures', () => {
  it('returns null for completely malformed input', () => {
    expect(parseTriageDecision('this is just prose, no JSON', PICKED_IDS)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTriageDecision('', PICKED_IDS)).toBeNull();
  });

  it('returns null for JSON missing message when shouldNudge:true', () => {
    const raw = JSON.stringify({ shouldNudge: true, itemId: VALID_ITEM_ID, urgency: 'low', reasoning: 'test' });
    expect(parseTriageDecision(raw, PICKED_IDS)).toBeNull();
  });

  it('returns null for message > 280 chars', () => {
    const raw = makeTrueDecision({ message: 'x'.repeat(281) });
    expect(parseTriageDecision(raw, PICKED_IDS)).toBeNull();
  });
});

describe('parseTriageDecision — hallucination defense', () => {
  it('returns null when itemId is valid shape but not in pickedItemIds', () => {
    const raw = makeTrueDecision({ itemId: '2026-01-01-zzzz' });
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).toBeNull();
  });

  it('accepts itemId that IS in pickedItemIds', () => {
    const raw = makeTrueDecision({ itemId: '2026-04-24-cd34' });
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
    if (result?.shouldNudge) {
      expect(result.itemId).toBe('2026-04-24-cd34');
    }
  });

  it('returns null when pickedItemIds is empty and shouldNudge:true', () => {
    const raw = makeTrueDecision();
    expect(parseTriageDecision(raw, [])).toBeNull();
  });
});

describe('parseTriageDecision — extra fields', () => {
  /**
   * Design choice: zod's default is strip (not strict). Extra fields are
   * silently ignored rather than causing rejection. LLMs often add fields
   * like "explanation" even when instructed not to; ignoring them is more
   * robust than failing the whole response.
   */
  it('accepts and strips extra keys silently (zod strip default)', () => {
    const raw = JSON.stringify({
      shouldNudge: false,
      reasoning: 'test',
      extraKey: 42,
      anotherField: 'hello',
    });
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
    expect(result?.shouldNudge).toBe(false);
    // Extra fields should be stripped from the result
    expect((result as Record<string, unknown>)['extraKey']).toBeUndefined();
  });

  it('accepts and strips extra keys on shouldNudge:true branch', () => {
    // v1.9.1 regression anchor: cover both branches of the discriminated union.
    const raw = JSON.stringify({
      shouldNudge: true,
      itemId: PICKED_IDS[0],
      message: 'walk 10 min',
      urgency: 'medium',
      reasoning: 'stale fitness goal',
      llmDebugTrace: 'chain-of-thought leaked here',
      confidenceScore: 0.82,
      extraNested: { foo: 'bar' },
    });
    const result = parseTriageDecision(raw, PICKED_IDS);
    expect(result).not.toBeNull();
    expect(result?.shouldNudge).toBe(true);
    expect((result as Record<string, unknown>)['llmDebugTrace']).toBeUndefined();
    expect((result as Record<string, unknown>)['confidenceScore']).toBeUndefined();
    expect((result as Record<string, unknown>)['extraNested']).toBeUndefined();
  });
});
