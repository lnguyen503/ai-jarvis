/**
 * Sub-Phase A — contextBuilder unit tests.
 * Verifies Message → Anthropic.MessageParam translation, trim-to-maxHistory,
 * and tool_use / tool_result block shape.
 */
import { describe, it, expect } from 'vitest';
import { buildMessages } from '../../src/agent/contextBuilder.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { Message } from '../../src/memory/messages.js';

function msg(p: Partial<Message> & { role: Message['role']; id: number }): Message {
  return {
    id: p.id,
    session_id: p.session_id ?? 1,
    role: p.role,
    content: p.content ?? null,
    tool_name: p.tool_name ?? null,
    tool_input: p.tool_input ?? null,
    tool_output: p.tool_output ?? null,
    tool_use_id: p.tool_use_id ?? null,
    created_at: p.created_at ?? '2026-01-01T00:00:00Z',
  };
}

describe('agent.contextBuilder.buildMessages', () => {
  it('converts user + assistant text messages', () => {
    const cfg = makeTestConfig();
    const history: Message[] = [
      msg({ id: 1, role: 'user', content: 'hello' }),
      msg({ id: 2, role: 'assistant', content: 'hi back' }),
    ];
    const out = buildMessages(history, 'next turn', cfg);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'user', content: 'hello' });
    expect(out[1]).toEqual({ role: 'assistant', content: 'hi back' });
    expect(out[2]).toEqual({ role: 'user', content: 'next turn' });
  });

  it('produces a tool_use block for assistant turns with tool_name + tool_input', () => {
    const cfg = makeTestConfig();
    const history: Message[] = [
      msg({
        id: 1,
        role: 'assistant',
        content: 'running a command',
        tool_name: 'run_command',
        tool_input: JSON.stringify({ command: 'ls' }),
        tool_use_id: 'toolu_abc',
      }),
      // Matching tool_result so the tool_use is not stripped as dangling
      msg({ id: 2, role: 'tool', tool_use_id: 'toolu_abc', tool_output: 'ok' }),
      msg({ id: 3, role: 'assistant', content: 'done' }),
    ];
    const out = buildMessages(history, 'go', cfg);
    expect(out[0]?.role).toBe('assistant');
    const content = out[0]?.content as Array<{ type: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((b) => b.type === 'text')).toBe(true);
    expect(content.some((b) => b.type === 'tool_use')).toBe(true);
  });

  it('produces a tool_result user block for tool messages', () => {
    const cfg = makeTestConfig();
    const history: Message[] = [
      // Preceding assistant tool_use so the tool_result is not orphaned
      msg({
        id: 1,
        role: 'assistant',
        tool_name: 'run_command',
        tool_input: JSON.stringify({ command: 'ls' }),
        tool_use_id: 'toolu_abc',
      }),
      msg({
        id: 2,
        role: 'tool',
        tool_output: 'output text',
        tool_use_id: 'toolu_abc',
      }),
      msg({ id: 3, role: 'assistant', content: 'ok' }),
    ];
    const out = buildMessages(history, 'continue', cfg);
    // [assistant tool_use, user tool_result, assistant text, user "continue"]
    expect(out[1]?.role).toBe('user');
    const content = out[1]?.content as Array<{ type: string; tool_use_id: string }>;
    expect(content[0]?.type).toBe('tool_result');
    expect(content[0]?.tool_use_id).toBe('toolu_abc');
  });

  it('trims history to maxHistoryMessages (keeps tail) before appending new user turn', () => {
    const cfg = makeTestConfig({
      memory: { dbPath: ':memory:', maxHistoryMessages: 3 },
    });
    const history: Message[] = Array.from({ length: 10 }, (_, i) =>
      msg({ id: i + 1, role: 'user', content: `m${i + 1}` }),
    );
    const out = buildMessages(history, 'NEW', cfg);
    // 3 trimmed history + 1 new user = 4
    expect(out).toHaveLength(4);
    expect(out[0]?.content).toBe('m8');
    expect(out[2]?.content).toBe('m10');
    expect(out[3]?.content).toBe('NEW');
  });

  it('excludes system-role rows from the messages array', () => {
    const cfg = makeTestConfig();
    const history: Message[] = [
      msg({ id: 1, role: 'system', content: 'system note' }),
      msg({ id: 2, role: 'user', content: 'hello' }),
    ];
    const out = buildMessages(history, 'x', cfg);
    // system row skipped; user + new user = 2
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe('hello');
  });

  it('drops orphaned tool_result blocks whose matching tool_use was trimmed (regression)', () => {
    const cfg = makeTestConfig();
    cfg.memory.maxHistoryMessages = 2; // force tail-trim to orphan the tool_use

    const history: Message[] = [
      msg({
        id: 1,
        role: 'assistant',
        tool_name: 'run_command',
        tool_input: JSON.stringify({ command: 'ls' }),
        tool_use_id: 'toolu_orphan',
      }),
      msg({
        id: 2,
        role: 'tool',
        tool_use_id: 'toolu_orphan',
        tool_output: 'file listing',
      }),
      msg({ id: 3, role: 'assistant', content: 'done' }),
    ];

    const out = buildMessages(history, 'next', cfg);

    // The orphaned tool_result must NOT appear — Claude would reject it.
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('toolu_orphan');
    expect(flat).not.toContain('tool_result');
  });

  it('drops a trailing assistant tool_use when the next turn will be plain user text (regression)', () => {
    const cfg = makeTestConfig();
    const history: Message[] = [
      msg({ id: 1, role: 'user', content: 'run ls' }),
      msg({
        id: 2,
        role: 'assistant',
        content: 'running',
        tool_name: 'run_command',
        tool_input: JSON.stringify({ command: 'ls' }),
        tool_use_id: 'toolu_dangling',
      }),
    ];

    const out = buildMessages(history, 'never mind', cfg);
    const flat = JSON.stringify(out);
    // Dangling tool_use must be stripped; the assistant's text survives
    expect(flat).not.toContain('tool_use');
    expect(flat).not.toContain('toolu_dangling');
    expect(flat).toContain('running');
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'never mind' });
  });

  it('keeps a valid tool_use/tool_result pair untouched', () => {
    const cfg = makeTestConfig();
    const history: Message[] = [
      msg({ id: 1, role: 'user', content: 'run ls' }),
      msg({
        id: 2,
        role: 'assistant',
        tool_name: 'run_command',
        tool_input: JSON.stringify({ command: 'ls' }),
        tool_use_id: 'toolu_ok',
      }),
      msg({ id: 3, role: 'tool', tool_use_id: 'toolu_ok', tool_output: 'file-a' }),
      msg({ id: 4, role: 'assistant', content: 'there is one file' }),
    ];

    const out = buildMessages(history, 'thanks', cfg);
    const flat = JSON.stringify(out);
    expect(flat).toContain('toolu_ok');
    expect(flat).toContain('tool_use');
    expect(flat).toContain('tool_result');
    expect(flat).toContain('file-a');
  });
});
