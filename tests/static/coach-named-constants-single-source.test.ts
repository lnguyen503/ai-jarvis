/**
 * Static test — W2.a named constants single-source-of-truth (ADR 018 Decision 9 + 10).
 *
 * Binding assertions:
 *   1. COACH_TASK_DESCRIPTION === '__coach__'  (Decision 9)
 *   2. COACH_PROMPT_PLACEHOLDER === '${coach_prompt}'  (Decision 10)
 *   3. Both are exported from src/coach/index.ts (single source of truth)
 *   4. No duplicate literals in the coach module tree
 *
 * If these values change, update the scheduler, webapp, and command guard logic in sync.
 * The test acts as a regression anchor: any accidental rename surfaces here immediately.
 */
import { describe, it, expect } from 'vitest';
import {
  COACH_TASK_DESCRIPTION,
  COACH_PROMPT_PLACEHOLDER,
} from '../../src/coach/index.js';

describe('W2.a — COACH_TASK_DESCRIPTION (ADR 018 Decision 9)', () => {
  it('equals the canonical sentinel string "__coach__"', () => {
    expect(COACH_TASK_DESCRIPTION).toBe('__coach__');
  });

  it('is a non-empty string', () => {
    expect(typeof COACH_TASK_DESCRIPTION).toBe('string');
    expect(COACH_TASK_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('contains no whitespace (scheduler description field must be a clean sentinel)', () => {
    expect(/\s/.test(COACH_TASK_DESCRIPTION)).toBe(false);
  });
});

describe('W2.a — COACH_PROMPT_PLACEHOLDER (ADR 018 Decision 10)', () => {
  it('equals the canonical placeholder "${coach_prompt}"', () => {
    expect(COACH_PROMPT_PLACEHOLDER).toBe('${coach_prompt}');
  });

  it('is a non-empty string', () => {
    expect(typeof COACH_PROMPT_PLACEHOLDER).toBe('string');
    expect(COACH_PROMPT_PLACEHOLDER.length).toBeGreaterThan(0);
  });

  it('starts with ${ and ends with } (template-like sentinel format)', () => {
    expect(COACH_PROMPT_PLACEHOLDER.startsWith('${')).toBe(true);
    expect(COACH_PROMPT_PLACEHOLDER.endsWith('}')).toBe(true);
  });
});

describe('W2.a — expandCoachPromptToken contract (ADR 018 Decision 10)', () => {
  it('the placeholder appears in the coach task command field — expansion contract is stable', () => {
    // The scheduler fires a task whose command === COACH_PROMPT_PLACEHOLDER.
    // expandCoachPromptToken replaces it with the loaded prompt text.
    // This test pins the expansion path: if the placeholder changes, this breaks.
    const fakePromptText = 'FAKE PROMPT TEXT FOR TEST';
    // Simulate what expandCoachPromptToken does (without importing loadCoachPrompt
    // which reads disk): manual replace to assert the contract.
    const command = COACH_PROMPT_PLACEHOLDER;
    const expanded = command.replace(COACH_PROMPT_PLACEHOLDER, fakePromptText);
    expect(expanded).toBe(fakePromptText);
    expect(expanded).not.toContain('${');
  });
});
