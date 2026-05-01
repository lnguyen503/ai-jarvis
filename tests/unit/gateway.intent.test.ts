/**
 * Unit tests for src/gateway/intent.ts — output parser robustness and
 * classifier call shape (with a mock provider so no live API calls).
 */
import { describe, it, expect } from 'vitest';
import {
  parseClassifierOutput,
  classifyAddressedToBot,
} from '../../src/gateway/intent.js';
import type { ModelProvider, UnifiedResponse } from '../../src/providers/types.js';

function mockProvider(content: string): ModelProvider {
  return {
    name: 'mock',
    async call(): Promise<UnifiedResponse> {
      return {
        stop_reason: 'end_turn',
        content,
        tool_calls: [],
        provider: 'mock',
        model: 'mock',
      };
    },
  };
}

function throwingProvider(msg: string): ModelProvider {
  return {
    name: 'mock',
    async call(): Promise<UnifiedResponse> {
      throw new Error(msg);
    },
  };
}

describe('parseClassifierOutput', () => {
  it('parses a clean JSON object', () => {
    const r = parseClassifierOutput('{"addressed":true,"confidence":"high","reason":"imperative"}');
    expect(r).toEqual({ addressed: true, confidence: 'high', reason: 'imperative' });
  });

  it('strips ```json fences', () => {
    const r = parseClassifierOutput(
      '```json\n{"addressed":false,"confidence":"low","reason":"social"}\n```',
    );
    expect(r).toEqual({ addressed: false, confidence: 'low', reason: 'social' });
  });

  it('handles leading prose', () => {
    const r = parseClassifierOutput(
      'Here is my answer: {"addressed":true,"confidence":"medium","reason":"ambiguous"}',
    );
    expect(r.addressed).toBe(true);
    expect(r.confidence).toBe('medium');
  });

  it('defaults confidence to low for invalid values', () => {
    const r = parseClassifierOutput('{"addressed":true,"confidence":"very-high","reason":"x"}');
    expect(r.confidence).toBe('low');
  });

  it('returns low-confidence not-addressed on completely garbage input', () => {
    const r = parseClassifierOutput('this is not json and has no braces');
    expect(r).toEqual({ addressed: false, confidence: 'low', reason: 'unparseable' });
  });

  it('returns unparseable on an empty string', () => {
    const r = parseClassifierOutput('');
    expect(r.addressed).toBe(false);
    expect(r.reason).toBe('unparseable');
  });

  it('truncates very long reasons to 120 chars', () => {
    const long = 'a'.repeat(500);
    const r = parseClassifierOutput(`{"addressed":true,"confidence":"low","reason":"${long}"}`);
    expect(r.reason.length).toBe(120);
  });

  it('coerces missing fields to safe defaults', () => {
    const r = parseClassifierOutput('{}');
    expect(r).toEqual({ addressed: false, confidence: 'low', reason: '' });
  });
});

describe('classifyAddressedToBot', () => {
  const baseParams = (provider: ModelProvider) => ({
    text: 'search my inbox for invoices',
    senderName: 'Boss',
    recent: [],
    botSpokeRecently: false,
    provider,
    model: 'gemma4:cloud',
    abortSignal: new AbortController().signal,
  });

  it('happy path: high confidence addressed', async () => {
    const r = await classifyAddressedToBot(
      baseParams(
        mockProvider('{"addressed":true,"confidence":"high","reason":"imperative cmd"}'),
      ),
    );
    expect(r).toEqual({ addressed: true, confidence: 'high', reason: 'imperative cmd' });
  });

  it('provider throws → defaults to silent low-confidence', async () => {
    const r = await classifyAddressedToBot(baseParams(throwingProvider('boom')));
    expect(r.addressed).toBe(false);
    expect(r.confidence).toBe('low');
    expect(r.reason).toContain('classifier error');
    expect(r.reason).toContain('boom');
  });

  it('malformed JSON output → silent low-confidence', async () => {
    const r = await classifyAddressedToBot(
      baseParams(mockProvider('Oh hi I think maybe this is a question?')),
    );
    expect(r.addressed).toBe(false);
    expect(r.confidence).toBe('low');
  });

  it('includes recent messages + sender context in the prompt', async () => {
    let captured = '';
    const capturingProvider: ModelProvider = {
      name: 'mock',
      async call(params): Promise<UnifiedResponse> {
        captured = String(params.messages[0]?.content ?? '');
        return {
          stop_reason: 'end_turn',
          content: '{"addressed":false,"confidence":"low","reason":"ok"}',
          tool_calls: [],
          provider: 'mock',
          model: 'mock',
        };
      },
    };
    await classifyAddressedToBot({
      ...baseParams(capturingProvider),
      senderName: 'Boss',
      text: 'do that thing',
      recent: [
        { from: 'Kim', text: 'how was your weekend?' },
        { from: 'Boss', text: 'not bad' },
      ],
      botSpokeRecently: true,
    });
    expect(captured).toContain('Kim: how was your weekend');
    expect(captured).toContain('Boss: not bad');
    expect(captured).toContain('New message from Boss');
    expect(captured).toContain('do that thing');
    expect(captured).toContain('Jarvis spoke in this chat within the last');
  });
});
