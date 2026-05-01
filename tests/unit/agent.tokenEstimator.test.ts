/**
 * Unit tests for src/agent/tokenEstimator.ts
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, getCurrentContextLimit } from '../../src/agent/tokenEstimator.js';
import type { UnifiedMessage } from '../../src/providers/types.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates based on content length / 4', () => {
    const msgs: UnifiedMessage[] = [
      { role: 'user', content: 'abcd' }, // 4 chars = 1 token
    ];
    expect(estimateTokens(msgs)).toBe(1);
  });

  it('counts tool_result block content', () => {
    const msgs: UnifiedMessage[] = [
      {
        role: 'user',
        blocks: [{ type: 'tool_result', tool_call_id: 'x', content: 'aaaa' }],
      },
    ];
    expect(estimateTokens(msgs)).toBe(1);
  });

  it('counts tool_call args', () => {
    const msgs: UnifiedMessage[] = [
      {
        role: 'assistant',
        tool_calls: [{ id: 'tc1', name: 'run', input: { command: 'ls' } }],
      },
    ];
    // 'run'.length + JSON.stringify({command:'ls'}).length = 3 + 15 = 18 chars → ceil(18/4) = 5
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });

  it('accumulates across multiple messages', () => {
    const msgs: UnifiedMessage[] = [
      { role: 'user', content: '1234' },
      { role: 'assistant', content: '5678' },
    ];
    // 8 chars total = 2 tokens
    expect(estimateTokens(msgs)).toBe(2);
  });

  it('counts text block content', () => {
    const msgs: UnifiedMessage[] = [
      {
        role: 'user',
        blocks: [{ type: 'text', text: 'hello' }],
      },
    ];
    // 5 chars = ceil(5/4) = 2 tokens
    expect(estimateTokens(msgs)).toBe(2);
  });
});

describe('getCurrentContextLimit', () => {
  it('returns known Claude limit', () => {
    const cfg = makeTestConfig();
    const limit = getCurrentContextLimit(cfg, 'claude', 'claude-sonnet-4-6');
    expect(limit).toBe(200000);
  });

  it('returns known Ollama model limit', () => {
    const cfg = makeTestConfig();
    const limit = getCurrentContextLimit(cfg, 'ollama-cloud', 'glm-5.1:cloud');
    expect(limit).toBe(32000);
  });

  it('falls back to 32000 for unknown model', () => {
    const cfg = makeTestConfig();
    const limit = getCurrentContextLimit(cfg, 'ollama-cloud', 'unknown-model:v9');
    expect(limit).toBe(32000);
  });

  it('reads context limit from config.ai.providers if defined', () => {
    const cfg = makeTestConfig();
    // Manually set a context limit in the providers config
    (cfg.ai.providers as Record<string, { models?: Record<string, string> }>)['claude'] = {
      models: { 'my-custom-model': '50000' },
    };
    const limit = getCurrentContextLimit(cfg, 'claude', 'my-custom-model');
    expect(limit).toBe(50000);
  });
});
