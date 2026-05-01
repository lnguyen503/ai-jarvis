/**
 * Tests for src/providers/adapters.ts:
 * - stripThinkTags
 * - toAnthropicMessages / extractAnthropicText / extractAnthropicToolCalls
 * - toOpenAIMessages / parseOpenAIToolCalls
 */
import { describe, it, expect } from 'vitest';
import {
  stripThinkTags,
  toOpenAIMessages,
  parseOpenAIToolCalls,
  type OpenAIToolCallRaw,
} from '../../src/providers/adapters.js';
import type { UnifiedMessage } from '../../src/providers/types.js';

// ---------------------------------------------------------------------------
// stripThinkTags
// ---------------------------------------------------------------------------

describe('stripThinkTags', () => {
  it('removes <think>...</think> blocks', () => {
    const input = '<think>This is internal reasoning.</think>Final answer.';
    expect(stripThinkTags(input)).toBe('Final answer.');
  });

  it('removes multiple think blocks', () => {
    const input = '<think>A</think> hello <think>B</think> world';
    expect(stripThinkTags(input)).toBe('hello  world');
  });

  it('handles multiline think blocks', () => {
    const input = '<think>\nLine 1\nLine 2\n</think>Answer.';
    expect(stripThinkTags(input)).toBe('Answer.');
  });

  it('removes ```think ... ``` code fences', () => {
    const input = '```think\nsome reasoning\n```\nFinal.';
    expect(stripThinkTags(input)).toBe('Final.');
  });

  it('removes ```reasoning ... ``` code fences', () => {
    const input = '```reasoning\nsome reasoning\n```\nAnswer.';
    expect(stripThinkTags(input)).toBe('Answer.');
  });

  it('is case-insensitive for think tag', () => {
    const input = '<THINK>hidden</THINK>visible';
    expect(stripThinkTags(input)).toBe('visible');
  });

  it('returns unchanged string with no think tags', () => {
    const input = 'Hello, world!';
    expect(stripThinkTags(input)).toBe('Hello, world!');
  });

  it('handles empty string', () => {
    expect(stripThinkTags('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// toOpenAIMessages
// ---------------------------------------------------------------------------

describe('toOpenAIMessages', () => {
  it('converts system message', () => {
    const messages: UnifiedMessage[] = [{ role: 'system', content: 'You are helpful.' }];
    const result = toOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'system', content: 'You are helpful.' });
  });

  it('converts user message', () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Hello' });
  });

  it('converts assistant message without tool_calls', () => {
    const messages: UnifiedMessage[] = [{ role: 'assistant', content: 'I can help.' }];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toMatchObject({ role: 'assistant', content: 'I can help.' });
  });

  it('converts assistant message with tool_calls', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'tc_1', name: 'system_info', input: {} }],
      },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]?.role).toBe('assistant');
    expect(result[0]?.tool_calls).toHaveLength(1);
    expect(result[0]?.tool_calls?.[0]).toMatchObject({
      id: 'tc_1',
      type: 'function',
      function: { name: 'system_info', arguments: '{}' },
    });
  });

  it('converts tool result blocks to tool messages', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'user',
        blocks: [
          { type: 'tool_result', tool_call_id: 'tc_1', content: 'result data' },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toMatchObject({
      role: 'tool',
      content: 'result data',
      tool_call_id: 'tc_1',
    });
  });

  it('handles mixed message sequence', () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'Question?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc_2', name: 'read_file', input: { path: '/tmp/x' } }],
      },
      {
        role: 'user',
        blocks: [{ type: 'tool_result', tool_call_id: 'tc_2', content: 'file content' }],
      },
    ];
    const result = toOpenAIMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]?.role).toBe('system');
    expect(result[1]?.role).toBe('user');
    expect(result[2]?.role).toBe('assistant');
    expect(result[3]?.role).toBe('tool');
  });
});

// ---------------------------------------------------------------------------
// parseOpenAIToolCalls
// ---------------------------------------------------------------------------

describe('parseOpenAIToolCalls', () => {
  it('parses valid tool calls', () => {
    const raw: OpenAIToolCallRaw[] = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'system_info', arguments: '{}' },
      },
    ];
    const result = parseOpenAIToolCalls(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'call_1', name: 'system_info', input: {} });
  });

  it('parses tool call with complex arguments', () => {
    const raw: OpenAIToolCallRaw[] = [
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/x","encoding":"utf8"}' },
      },
    ];
    const result = parseOpenAIToolCalls(raw);
    expect(result[0]?.input).toMatchObject({ path: '/tmp/x', encoding: 'utf8' });
  });

  it('throws on missing function name', () => {
    const raw: OpenAIToolCallRaw[] = [
      { id: 'bad', type: 'function' }, // no function property
    ];
    expect(() => parseOpenAIToolCalls(raw)).toThrow(/Malformed tool_call/);
  });

  it('throws on invalid JSON arguments', () => {
    const raw: OpenAIToolCallRaw[] = [
      {
        id: 'bad_json',
        type: 'function',
        function: { name: 'tool', arguments: 'not-json' },
      },
    ];
    expect(() => parseOpenAIToolCalls(raw)).toThrow(/Malformed tool_call/);
  });

  it('returns empty array for empty input', () => {
    expect(parseOpenAIToolCalls([])).toHaveLength(0);
  });

  it('parses multiple tool calls', () => {
    const raw: OpenAIToolCallRaw[] = [
      { id: 'a', type: 'function', function: { name: 'f1', arguments: '{"x":1}' } },
      { id: 'b', type: 'function', function: { name: 'f2', arguments: '{"y":2}' } },
    ];
    const result = parseOpenAIToolCalls(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('f1');
    expect(result[1]?.name).toBe('f2');
  });
});
