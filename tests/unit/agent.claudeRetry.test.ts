/**
 * Sub-Phase A — Claude API retry/backoff unit tests.
 * Mocks client.messages.create to simulate 429/529/5xx + network errors.
 */
import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { callClaude } from '../../src/agent/claude.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

function mockClient(impl: () => Promise<unknown>): Anthropic {
  return {
    messages: { create: vi.fn(impl) },
  } as unknown as Anthropic;
}

describe('agent.claude.callClaude retry logic', () => {
  it('retries on 529 overloaded and eventually succeeds', async () => {
    const cfg = makeTestConfig();
    let calls = 0;
    const mock = mockClient(async () => {
      calls++;
      if (calls < 2) {
        const err = new Anthropic.APIError(529, { error: { message: 'overloaded' } }, 'overloaded', {});
        throw err;
      }
      return { id: 'msg_ok', content: [] } as unknown;
    });
    const res = await callClaude(
      mock,
      { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      cfg,
      new AbortController().signal,
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((res as { id: string }).id).toBe('msg_ok');
  }, 15000);

  it('throws CLAUDE_UNREACHABLE after exhausting retries on persistent 500', async () => {
    const cfg = makeTestConfig();
    const mock = mockClient(async () => {
      throw new Anthropic.APIError(500, { error: { message: 'server error' } }, 'server error', {});
    });
    await expect(
      callClaude(
        mock,
        { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
        cfg,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLAUDE_UNREACHABLE' });
  }, 30000);

  it('aborts immediately when the AbortSignal is pre-aborted', async () => {
    const cfg = makeTestConfig();
    const mock = mockClient(async () => ({ id: 'ok' }) as unknown);
    const ac = new AbortController();
    ac.abort();
    await expect(
      callClaude(
        mock,
        { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
        cfg,
        ac.signal,
      ),
    ).rejects.toThrow(/aborted/i);
  });

  it('retries on a generic network error and succeeds on retry', async () => {
    const cfg = makeTestConfig();
    let calls = 0;
    const mock = mockClient(async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return { id: 'msg_ok' } as unknown;
    });
    const res = await callClaude(
      mock,
      { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      cfg,
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    expect((res as { id: string }).id).toBe('msg_ok');
  }, 15000);
});
