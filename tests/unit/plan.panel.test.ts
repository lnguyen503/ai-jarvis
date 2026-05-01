import { describe, expect, it } from 'vitest';
import { renderPanel, createPanelUpdater, renderCostLine } from '../../src/plan/panel.js';
import type { Plan } from '../../src/plan/types.js';
import { researchSkill } from '../../src/skill/research.js';
import { makeMockTelegramAdapter } from '../fixtures/mockTelegramAdapter.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'pl_abc123',
    goal: 'research the EV market',
    planDir: '/tmp/plans/pl_abc123',
    chatId: 12345,
    panelMessageId: 99,
    startedAt: Date.now(),
    status: 'running',
    skill: researchSkill,
    tasks: [
      { index: 1, title: 'Search news', status: 'completed', summary: 'found 10 articles' },
      { index: 2, title: 'Read top 3 results', status: 'running' },
      { index: 3, title: 'Compose summary', status: 'pending' },
    ],
    ...overrides,
  };
}

describe('renderPanel', () => {
  it('renders header with id and task count', () => {
    const txt = renderPanel(makePlan());
    expect(txt).toContain('pl_abc123');
    expect(txt).toContain('3 tasks');
    expect(txt).toContain('research the EV market');
  });

  it('renders the skill label as the first word', () => {
    // Research skill → "🤖 Research: ..."
    const txt = renderPanel(makePlan());
    expect(txt).toMatch(/🤖 Research: research the EV market/);
  });

  it('uses status icons for each state', () => {
    const txt = renderPanel(makePlan());
    expect(txt).toContain('✓ 1.');
    expect(txt).toContain('⋯ 2.');
    expect(txt).toContain('  3.'); // pending = blank icon (two spaces)
  });

  it('shows completed task summary on a sub-line', () => {
    const txt = renderPanel(makePlan());
    expect(txt).toContain('found 10 articles');
  });

  it('shows failed task error with warning marker', () => {
    const plan = makePlan({
      tasks: [
        { index: 1, title: 'Doomed task', status: 'failed', error: 'rate limited' },
      ],
    });
    const txt = renderPanel(plan);
    expect(txt).toContain('✗ 1.');
    expect(txt).toContain('⚠ rate limited');
  });

  it('shows the completion footer when plan finishes', () => {
    const plan = makePlan({ status: 'completed' });
    expect(renderPanel(plan)).toContain('✅ Plan complete');
  });

  it('shows the cancelled footer when cancelled', () => {
    const plan = makePlan({ status: 'cancelled' });
    expect(renderPanel(plan)).toContain('⊘ Plan cancelled');
  });

  it('truncates long task titles', () => {
    const longTitle = 'x'.repeat(300);
    const plan = makePlan({
      tasks: [{ index: 1, title: longTitle, status: 'pending' }],
    });
    const txt = renderPanel(plan);
    expect(txt).toContain('…');
    expect(txt.length).toBeLessThan(500);
  });

  it('falls back to compact mode when normal rendering exceeds budget', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      title: 'Task ' + 'x'.repeat(150), // long title with summary
      status: 'completed' as const,
      summary: 'y'.repeat(120),
    }));
    const txt = renderPanel(makePlan({ tasks }));
    expect(txt.length).toBeLessThan(4000);
    expect(txt).toContain('Task ');
  });
});

describe('renderCostLine', () => {
  it('is empty for Ollama plans', () => {
    const plan = makePlan({
      forceProvider: undefined,
      totalUsage: { input_tokens: 50_000, output_tokens: 10_000 },
    });
    expect(renderCostLine(plan)).toBe('');
  });

  it('is empty for Claude plans with no usage yet', () => {
    const plan = makePlan({ forceProvider: 'claude', totalUsage: undefined });
    expect(renderCostLine(plan)).toBe('');
  });

  it('computes Sonnet cost correctly (no caching)', () => {
    // Sonnet: 50k in @ $3/MT + 10k out @ $15/MT = $0.15 + $0.15 = $0.30
    const plan = makePlan({
      forceProvider: 'claude',
      modelUsed: 'claude-sonnet-4-6',
      totalUsage: { input_tokens: 50_000, output_tokens: 10_000 },
    });
    const line = renderCostLine(plan);
    expect(line).toContain('$0.30');
    expect(line).toContain('sonnet');
    expect(line).toContain('50.0k in');
    expect(line).toContain('10.0k out');
  });

  it('computes Haiku cost correctly (no caching) — much cheaper than Sonnet', () => {
    // Haiku: 50k in @ $0.80/MT + 10k out @ $4/MT = $0.04 + $0.04 = $0.08
    const plan = makePlan({
      forceProvider: 'claude',
      modelUsed: 'claude-haiku-4-5',
      totalUsage: { input_tokens: 50_000, output_tokens: 10_000 },
    });
    const line = renderCostLine(plan);
    expect(line).toContain('$0.08');
    expect(line).toContain('haiku');
  });

  it('discounts cache_read tokens at 10% of input price', () => {
    // Haiku w/ caching: 10k full + 40k cached + 10k out
    //  = 10k × $0.80 + 40k × $0.08 + 10k × $4 (per million)
    //  = $0.008 + $0.0032 + $0.04 = $0.0512 → "$0.05"
    const plan = makePlan({
      forceProvider: 'claude',
      modelUsed: 'claude-haiku-4-5',
      totalUsage: {
        input_tokens: 10_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 40_000,
        output_tokens: 10_000,
      },
    });
    const line = renderCostLine(plan);
    expect(line).toContain('$0.05');
    expect(line).toContain('80% cached'); // 40k of 50k input was cached
  });

  it('formats small token counts without k', () => {
    const plan = makePlan({
      forceProvider: 'claude',
      modelUsed: 'claude-haiku-4-5',
      totalUsage: { input_tokens: 500, output_tokens: 200 },
    });
    const line = renderCostLine(plan);
    expect(line).toContain('500 in');
    expect(line).toContain('200 out');
  });
});

describe('createPanelUpdater', () => {
  it('flushes immediately on flush()', async () => {
    const adapter = makeMockTelegramAdapter();
    const plan = makePlan();
    const updater = createPanelUpdater(adapter, plan);

    await updater.flush();

    expect(adapter.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text] = adapter.editMessageText.mock.calls[0];
    expect(chatId).toBe(12345);
    expect(messageId).toBe(99);
    expect(text).toContain('pl_abc123');
  });

  it('does not edit twice with identical text', async () => {
    const adapter = makeMockTelegramAdapter();
    const plan = makePlan();
    const updater = createPanelUpdater(adapter, plan);

    await updater.flush();
    await updater.flush(); // identical state — should be no-op

    expect(adapter.editMessageText).toHaveBeenCalledTimes(1);
  });

  it('survives a "message is not modified" error from Telegram', async () => {
    const adapter = makeMockTelegramAdapter();
    adapter.editMessageText.mockRejectedValueOnce(
      new Error('Bad Request: message is not modified'),
    );
    const plan = makePlan();
    const updater = createPanelUpdater(adapter, plan);

    await expect(updater.flush()).resolves.not.toThrow();
  });
});
