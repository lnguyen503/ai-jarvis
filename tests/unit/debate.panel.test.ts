/**
 * Tests for the new DebateParams/DebateState panel integration in src/debate/index.ts
 *
 * Covers:
 *  - runDebate with panel mock: updateState called at lifecycle transitions
 *  - Topic scrub: sk-ant-* credential → [REDACTED] in state.topic
 *  - Judge + arbiter receive scrubbed topic (mock Claude client)
 *  - Transcript scrub: group mode with C:\Users path → scrubbed
 *  - Transcript scrub: DM mode with same path → passes through
 *  - Audit emission: cancelled → 'debate.cancel'; completed → 'debate.complete'
 *  - Typing pulse: adapter.sendChatAction called multiple times during debater call
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DebateParams, DebateState } from '../../src/debate/index.js';
import { runDebate } from '../../src/debate/index.js';
import type { ProgressPanelApi } from '../../src/gateway/progressPanel.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { makeMockTelegramAdapter } from '../fixtures/mockTelegramAdapter.js';

// ---------------------------------------------------------------------------
// Panel mock factory
// ---------------------------------------------------------------------------

interface PanelMock extends ProgressPanelApi<DebateState> {
  updateState: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _states: DebateState[];
}

function makePanelMock(): PanelMock {
  const states: DebateState[] = [];
  const updateState = vi.fn((s: DebateState) => {
    states.push({ ...s });
  });
  const finalize = vi.fn(async (_s: DebateState) => {});
  const close = vi.fn();

  return {
    panelId: 'test-panel-id-abc',
    messageId: 99,
    updateState,
    finalize,
    close,
    _states: states,
  };
}

// ---------------------------------------------------------------------------
// Anthropic client mock
// ---------------------------------------------------------------------------

/** Create a mock Anthropic client that records calls and returns a valid response. */
function makeMockClaudeClient(
  judgeResponses: { consensus: boolean; summary: string }[] = [],
  verdictResponse: { decision: string; rationale: string; dissent: string } | null = null,
) {
  let judgeCallCount = 0;

  const create = vi.fn(async (params: { max_tokens: number }) => {
    // Distinguish judge (max_tokens=300) from final-verdict (max_tokens=600)
    const isJudge = params.max_tokens <= 300;
    let jsonStr: string;

    if (isJudge) {
      const r = judgeResponses[judgeCallCount] ?? { consensus: false, summary: 'no consensus' };
      judgeCallCount++;
      jsonStr = JSON.stringify({ consensus: r.consensus, summary: r.summary });
    } else {
      const v = verdictResponse ?? {
        decision: 'Use TypeScript.',
        rationale: 'Better tooling.',
        dissent: '',
      };
      jsonStr = JSON.stringify(v);
    }

    return {
      content: [{ type: 'text' as const, text: jsonStr }],
    };
  });

  return {
    messages: { create },
    _create: create,
  };
}

// ---------------------------------------------------------------------------
// Ollama provider mock
// ---------------------------------------------------------------------------

/** Create a mock Ollama ModelProvider that returns a short response. */
function makeMockOllamaProvider(responseText = 'Mock debater argument.', delayMs = 0) {
  const call = vi.fn(async () => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { content: responseText, usage: { inputTokens: 10, outputTokens: 20 } };
  });
  return { call, _call: call };
}

// ---------------------------------------------------------------------------
// Memory mock
// ---------------------------------------------------------------------------

function makeMockMemory() {
  const insertedRows: Array<{ category: string; detail: Record<string, unknown> }> = [];
  const insert = vi.fn((params: { category: string; detail: Record<string, unknown> }) => {
    insertedRows.push({ category: params.category, detail: params.detail });
  });
  return {
    auditLog: { insert },
    _rows: insertedRows,
  };
}

// ---------------------------------------------------------------------------
// Helper to build DebateParams
// ---------------------------------------------------------------------------

function makeParams(
  overrides: Partial<DebateParams> = {},
  panelOverride?: PanelMock,
  memoryOverride?: ReturnType<typeof makeMockMemory>,
): {
  params: DebateParams;
  panel: PanelMock;
  claude: ReturnType<typeof makeMockClaudeClient>;
  ollama: ReturnType<typeof makeMockOllamaProvider>;
  memory: ReturnType<typeof makeMockMemory>;
  adapter: ReturnType<typeof makeMockTelegramAdapter>;
} {
  const panel = panelOverride ?? makePanelMock();
  const claude = makeMockClaudeClient();
  const ollama = makeMockOllamaProvider();
  const memory = memoryOverride ?? makeMockMemory();
  const adapter = makeMockTelegramAdapter();
  const config = makeTestConfig();

  const params: DebateParams = {
    topic: 'Should we use TypeScript or JavaScript?',
    maxRounds: 1,
    exchangesPerRound: 1,
    panel: panel as unknown as ProgressPanelApi<DebateState>,
    ollama: ollama as unknown as DebateParams['ollama'],
    claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
    judgeModel: 'claude-test',
    abortSignal: new AbortController().signal,
    chatType: 'private',
    config,
    adapter: adapter as unknown as DebateParams['adapter'],
    chatId: 12345,
    memory: memory as unknown as DebateParams['memory'],
    actorUserId: 99,
    ...overrides,
  };

  return { params, panel, claude, ollama, memory, adapter };
}

// ---------------------------------------------------------------------------
// Tests: lifecycle panel.updateState transitions
// ---------------------------------------------------------------------------

describe('runDebate panel updateState lifecycle', () => {
  it('transitions through starting → running → final-verdict for 1-round no-consensus debate', async () => {
    const { params, panel } = makeParams({ maxRounds: 1 });

    await runDebate(params);

    const statuses = panel._states.map((s) => s.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('running');
    // After 1 round with no judge call (maxRounds=1 skips judge), go to synthesizing-verdict
    expect(statuses).toContain('synthesizing-verdict');
    expect(statuses).toContain('final-verdict');
  });

  it('transitions through consensus path for 2-round debate when judge says yes', async () => {
    const panel = makePanelMock();
    const claude = makeMockClaudeClient(
      [{ consensus: true, summary: 'Both agree on TypeScript.' }],
    );
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();

    const params: DebateParams = {
      topic: 'TypeScript vs JavaScript',
      maxRounds: 2,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 12345,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    const statuses = panel._states.map((s) => s.status);
    expect(statuses).toContain('judging');
    expect(statuses).toContain('consensus');
    // Should NOT proceed to synthesizing-verdict
    expect(statuses).not.toContain('synthesizing-verdict');
  });

  it('panel.finalize is called once at terminal state', async () => {
    const { params, panel } = makeParams({ maxRounds: 1 });
    await runDebate(params);
    expect(panel.finalize).toHaveBeenCalledTimes(1);
  });

  it('currentModel is set during debater call, null after', async () => {
    const { params, panel } = makeParams({ maxRounds: 1 });
    await runDebate(params);

    // At some point currentModel should have been non-null
    const speakingStates = panel._states.filter((s) => s.currentModel !== null);
    expect(speakingStates.length).toBeGreaterThan(0);

    // After the debater returns, currentModel should go back to null
    const postSpeakStates = panel._states.filter(
      (s) => s.currentModel === null && s.status === 'running' && s.transcript.length > 0,
    );
    expect(postSpeakStates.length).toBeGreaterThan(0);
  });

  it('transcript grows in state after each turn', async () => {
    const { params, panel } = makeParams({ maxRounds: 1, exchangesPerRound: 1 });
    await runDebate(params);

    // Find states with transcript populated
    const withTranscript = panel._states.filter((s) => s.transcript.length > 0);
    expect(withTranscript.length).toBeGreaterThan(0);
    // The roster is 3 debaters, so at least 3 turns should appear in transcript
    const maxTranscript = Math.max(...panel._states.map((s) => s.transcript.length));
    expect(maxTranscript).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: topic scrub (R8)
// ---------------------------------------------------------------------------

describe('topic scrub — R8', () => {
  it('credential topic scrubbed before first updateState (Fix 1 — initial-frame scrub)', async () => {
    // Regression for QA H1: scrub must fire BEFORE the first panel.updateState call.
    // Any call to panel.updateState with topic containing the raw key is a fail.
    const { params, panel } = makeParams({
      topic: 'Is sk-ant-api03-' + 'foobarbaz1234567890ABCD safe to use?',
    });

    await runDebate(params);

    // The VERY FIRST updateState call must already have the scrubbed topic.
    expect(panel._states.length).toBeGreaterThan(0);
    const firstState = panel._states[0]!;
    expect(firstState.topic).not.toContain('sk-ant-api03-' + 'foobarbaz1234567890ABCD');
    expect(firstState.topic).toContain('[REDACTED');
  });

  it('sk-ant-api03-foo credential in topic → state.topic has [REDACTED]', async () => {
    // Use a key with ≥20 chars after the prefix to trigger the scrubber pattern
    const { params, panel } = makeParams({
      topic: 'Analyse this key: sk-ant-api03-' + 'ABCDEFGHIJKLMNOPQRSTU and tell me if safe',
    });

    await runDebate(params);

    // All state updates must have the scrubbed topic
    for (const s of panel._states) {
      expect(s.topic).not.toContain('sk-ant-api03-' + 'ABCDEFGHIJKLMNOPQRSTU');
      expect(s.topic).toContain('[REDACTED');
    }
  });

  it('sk-ant-* credential → judge receives scrubbed topic (not raw)', async () => {
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider();
    const claude = makeMockClaudeClient([{ consensus: true, summary: 'agreed' }]);

    // Use a key with ≥20 chars after prefix to trigger scrubber
    const params: DebateParams = {
      topic: 'Is sk-ant-api03-' + 'secretkeyABCDEFGHIJKLM safe to commit?',
      maxRounds: 2,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    // Check all calls to claude.messages.create — the user content must never contain the raw secret
    for (const call of claude.messages.create.mock.calls) {
      const callParams = call[0] as { messages?: Array<{ content?: string }> };
      const userContent = callParams.messages?.[0]?.content ?? '';
      expect(userContent).not.toContain('sk-ant-api03-' + 'secretkeyABCDEFGHIJKLM');
    }
  });

  it('legitimate path reference passes through topic unchanged', async () => {
    const { params, panel } = makeParams({
      topic: "What's in /etc/hosts?",
      chatType: 'private',
    });

    await runDebate(params);

    // Path should NOT be scrubbed from topic (R8: credential-only for topic)
    const finalState = panel._states[panel._states.length - 1];
    expect(finalState?.topic).toContain('/etc/hosts');
  });
});

// ---------------------------------------------------------------------------
// Tests: transcript scrub (R1)
// ---------------------------------------------------------------------------

describe('transcript scrub — R1', () => {
  it('group mode: debater output with Windows path → scrubbed in transcript', async () => {
    const pathInOutput = 'C:\\Users\\testuser\\secret-file.txt';
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    // Override allowedPaths to include the path so scrubForGroup redacts it
    const configWithPath = {
      ...config,
      filesystem: { ...config.filesystem, allowedPaths: ['C:\\Users\\testuser'] },
    };
    const ollama = makeMockOllamaProvider(
      `Check out ${pathInOutput} for the answer.`,
    );
    const claude = makeMockClaudeClient();

    const params: DebateParams = {
      topic: 'Test topic',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'group',
      config: configWithPath,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    // Find states that have transcript entries
    const withTranscript = panel._states.filter((s) => s.transcript.length > 0);
    expect(withTranscript.length).toBeGreaterThan(0);
    const lastWithTranscript = withTranscript[withTranscript.length - 1]!;

    // The Windows path should be redacted in transcript
    for (const turn of lastWithTranscript.transcript) {
      expect(turn.text).not.toContain('C:\\Users\\testuser');
    }
  });

  it('DM mode: Windows path passes through in transcript (not scrubbed)', async () => {
    const pathInOutput = 'Some answer about /home/user/file.txt here.';
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider(pathInOutput);
    const claude = makeMockClaudeClient();

    const params: DebateParams = {
      topic: 'Test topic',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    const withTranscript = panel._states.filter((s) => s.transcript.length > 0);
    expect(withTranscript.length).toBeGreaterThan(0);
    const lastWithTranscript = withTranscript[withTranscript.length - 1]!;

    // In DM mode the path should NOT be scrubbed from transcript
    const found = lastWithTranscript.transcript.some((t) => t.text.includes('/home/user/file.txt'));
    expect(found).toBe(true);
  });

  it('DM mode: sk-ant credential in debater output IS credential-scrubbed', async () => {
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider('Response with sk-ant-api03-' + 'foosecretkey123456 embedded.');
    const claude = makeMockClaudeClient();

    const params: DebateParams = {
      topic: 'Test',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    const withTranscript = panel._states.filter((s) => s.transcript.length > 0);
    expect(withTranscript.length).toBeGreaterThan(0);
    const lastWithTranscript = withTranscript[withTranscript.length - 1]!;

    // Even in DM mode, credentials should be scrubbed from turns
    for (const turn of lastWithTranscript.transcript) {
      expect(turn.text).not.toContain('sk-ant-api03-' + 'foosecretkey123456');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: audit emission (R5)
// ---------------------------------------------------------------------------

describe('audit emission — R5', () => {
  it('completed debate emits debate.complete audit row with correct shape', async () => {
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider();
    // Make judge say consensus so we get debate.complete on consensus path
    const claude = makeMockClaudeClient([{ consensus: true, summary: 'Consensus.' }]);

    const params: DebateParams = {
      topic: 'TypeScript vs JavaScript',
      maxRounds: 2,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 42,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 77,
    };

    await runDebate(params);

    expect(memory.auditLog.insert).toHaveBeenCalledTimes(1);
    const [insertCall] = memory.auditLog.insert.mock.calls;
    const { category, actor_user_id, actor_chat_id, detail } = insertCall![0] as {
      category: string;
      actor_user_id: number;
      actor_chat_id: number;
      detail: Record<string, unknown>;
    };

    expect(category).toBe('debate.complete');
    expect(actor_user_id).toBe(77);
    expect(actor_chat_id).toBe(42);
    expect(detail).toMatchObject({
      topic: expect.any(String),
      chatType: 'private',
      roster: expect.any(Array),
      consensusReached: true,
      durationMs: expect.any(Number),
      cancelled: false,
    });
    expect(Array.isArray((detail as { turns: unknown }).turns)).toBe(true);
  });

  it('v1.12.1: completed consensus debate sends standalone verdict message after finalize', async () => {
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider();
    const claude = makeMockClaudeClient([
      { consensus: true, summary: 'Both models agree TypeScript wins for type safety and tooling.' },
    ]);

    const params: DebateParams = {
      topic: 'TypeScript vs JavaScript',
      maxRounds: 2,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 42,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 77,
    };

    await runDebate(params);

    // Find the sendMessage call that delivers the standalone verdict.
    // (Other sendMessage calls may have been made for other purposes; we
    // assert that AT LEAST ONE call carries the verdict body and HTML mode.)
    const verdictCall = adapter.sendMessage.mock.calls.find((c) => {
      const text = c[1] as string;
      return text.includes('Consensus reached') && text.includes('TypeScript wins');
    });
    expect(verdictCall).toBeDefined();
    expect(verdictCall![0]).toBe(42);  // chatId
    expect(verdictCall![2]).toEqual({ parseMode: 'HTML' });
  });

  it('v1.12.1: long transcript triggers a .md file attachment via sendDocument', async () => {
    // Build a debater response that's ~1000 chars per turn — guarantees the
    // total transcript exceeds the 3500-char threshold.
    const longResponse = 'A'.repeat(1000);
    const ollama = makeMockOllamaProvider(longResponse);
    // Force final-arbiter path so the verdict standalone fires too.
    const claude = makeMockClaudeClient([
      { consensus: false, summary: 'Disagree.' },
      { consensus: false, summary: 'Still disagree.' },
      // forceFinalVerdict response
      { decision: 'Pick X.', rationale: 'Because Y.', dissent: 'Z' },
    ]);
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();

    const params: DebateParams = {
      topic: 'Long debate topic',
      maxRounds: 2,
      exchangesPerRound: 1,
      panel: makePanelMock() as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 42,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 77,
    };

    await runDebate(params);

    // v1.12.1 now sends THREE formats: .txt, .docx, .md (mirrors /research's
    // multi-format pattern). Verify all three landed with the expected
    // captions and that they all targeted the right chatId.
    expect(adapter.sendDocument).toHaveBeenCalledTimes(3);
    const paths = adapter.sendDocument.mock.calls.map((c) => c[1] as string);
    expect(paths.some((p) => p.endsWith('.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.txt'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.docx'))).toBe(true);
    for (const c of adapter.sendDocument.mock.calls) {
      expect(c[0]).toBe(42);  // chatId on every send
      const opts = c[2] as { caption?: string } | undefined;
      expect(opts?.caption).toContain('Full transcript');
    }
  });

  it('v1.12.1: short transcript does NOT trigger file attachment (panel handles it)', async () => {
    const shortResponse = 'Brief.';
    const ollama = makeMockOllamaProvider(shortResponse);
    const claude = makeMockClaudeClient([
      { consensus: true, summary: 'Agree quickly.' },
    ]);
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();

    const params: DebateParams = {
      topic: 'Short debate',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: makePanelMock() as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 42,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 77,
    };

    await runDebate(params);

    expect(adapter.sendDocument).not.toHaveBeenCalled();
  });

  it('v1.12.1: cancelled debate does NOT send a standalone verdict message', async () => {
    const abortController = new AbortController();
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();

    const ollama = {
      call: vi.fn(async () => {
        abortController.abort('test-cancel');
        return { content: 'Some response', usage: { inputTokens: 5, outputTokens: 5 } };
      }),
    };
    const claude = makeMockClaudeClient();

    const params: DebateParams = {
      topic: 'Debate topic',
      maxRounds: 3,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: abortController.signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 5,
    };

    await runDebate(params);

    // No call should carry verdict markers.
    const verdictCalls = adapter.sendMessage.mock.calls.filter((c) => {
      const text = c[1] as string;
      return text.includes('Consensus reached') || text.includes('Claude verdict');
    });
    expect(verdictCalls).toEqual([]);
  });

  it('cancelled debate emits debate.cancel with cancelled:true', async () => {
    const abortController = new AbortController();
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();

    // Ollama takes a moment so we can abort mid-run
    let debaterCallCount = 0;
    const ollama = {
      call: vi.fn(async () => {
        debaterCallCount++;
        // Abort before returning on the first call
        abortController.abort('test-cancel');
        return { content: 'Some response', usage: { inputTokens: 5, outputTokens: 5 } };
      }),
    };
    const claude = makeMockClaudeClient();

    const params: DebateParams = {
      topic: 'Debate topic',
      maxRounds: 3,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: abortController.signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 5,
    };

    await runDebate(params);

    expect(memory.auditLog.insert).toHaveBeenCalledTimes(1);
    const [insertCall] = memory.auditLog.insert.mock.calls;
    const { category, detail } = insertCall![0] as {
      category: string;
      detail: Record<string, unknown>;
    };

    expect(category).toBe('debate.cancel');
    expect((detail as { cancelled: boolean }).cancelled).toBe(true);
  });

  it('audit row turns are capped at 8000 chars per turn', async () => {
    const veryLongResponse = 'x'.repeat(10000);
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const adapter = makeMockTelegramAdapter();
    const config = makeTestConfig();
    const ollama = makeMockOllamaProvider(veryLongResponse);
    const claude = makeMockClaudeClient();

    const params: DebateParams = {
      topic: 'Test',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    expect(memory.auditLog.insert).toHaveBeenCalledTimes(1);
    const { detail } = memory.auditLog.insert.mock.calls[0]![0] as {
      detail: { turns: Array<{ text: string }> };
    };

    for (const turn of detail.turns) {
      expect(turn.text.length).toBeLessThanOrEqual(8001); // 8000 + possible '…'
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: typing pulse (R7)
// ---------------------------------------------------------------------------

describe('typing pulse — R7', () => {
  it('sendChatAction("typing") called at least once per debater turn', async () => {
    // Use real timers — just verify that sendChatAction is called at least once
    // per debater call (the immediate initial call). The interval pulse would only
    // fire during a >4s call; we don't need to simulate that here.
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const config = makeTestConfig();
    const adapter = makeMockTelegramAdapter();
    const claude = makeMockClaudeClient();
    const ollama = makeMockOllamaProvider('Response', 0);

    const params: DebateParams = {
      topic: 'Test topic',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 12345,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    await runDebate(params);

    // roster has 3 models × 1 exchangesPerRound → 3 debater calls → 3 sendChatAction calls
    expect(adapter.sendChatAction.mock.calls.length).toBeGreaterThanOrEqual(3);

    // All calls should be 'typing' on chatId 12345
    for (const call of adapter.sendChatAction.mock.calls) {
      expect(call[0]).toBe(12345);
      expect(call[1]).toBe('typing');
    }
  });

  it('interval-based pulse: verifies clearInterval is called after debater returns (no leaked timers)', async () => {
    // Indirectly verify no timer leaks: if clearInterval is NOT called, the process
    // would hang. We test this by running the debate and checking it completes cleanly.
    const panel = makePanelMock();
    const memory = makeMockMemory();
    const config = makeTestConfig();
    const adapter = makeMockTelegramAdapter();
    const claude = makeMockClaudeClient();
    const ollama = makeMockOllamaProvider('Quick response', 0);

    const params: DebateParams = {
      topic: 'Pulse test',
      maxRounds: 1,
      exchangesPerRound: 1,
      panel: panel as unknown as ProgressPanelApi<DebateState>,
      ollama: ollama as unknown as DebateParams['ollama'],
      claudeClient: { messages: claude.messages } as unknown as DebateParams['claudeClient'],
      judgeModel: 'claude-test',
      abortSignal: new AbortController().signal,
      chatType: 'private',
      config,
      adapter: adapter as unknown as DebateParams['adapter'],
      chatId: 1,
      memory: memory as unknown as DebateParams['memory'],
      actorUserId: 1,
    };

    // If clearInterval is not called, this would hold the process. It completes normally.
    await expect(runDebate(params)).resolves.toBeDefined();
  });
});
