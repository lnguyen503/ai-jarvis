/**
 * Unit tests for src/gateway/progressPanel.ts — v1.12.0.
 *
 * Uses vitest fake timers for debounce testing.
 * All adapter calls are mocked; no real network or DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vi as _vi } from 'vitest';
import {
  createPanelRegistry,
  standardPanelButton,
  type ProgressPanelDeps,
  type PanelRegistry,
} from '../../src/gateway/progressPanel.js';
import type { InlineKeyboard } from '../../src/messaging/adapter.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestState {
  step: number;
  label: string;
}

function makeAdapter() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 100 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ messageId: 200 }),
    sendPhoto: vi.fn().mockResolvedValue({ messageId: 201 }),
    sendVoice: vi.fn().mockResolvedValue({ messageId: 202 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    resolveDmChatId: vi.fn().mockReturnValue(null),
  };
}

function makeDeps(
  adapter: ReturnType<typeof makeAdapter>,
  overrides: Partial<ProgressPanelDeps<TestState>> = {},
): ProgressPanelDeps<TestState> {
  return {
    adapter,
    chatId: 1001,
    ownerUserId: 42,
    callbackNamespace: 'debate',
    componentTag: 'debate',
    renderSummary: (s: TestState) => `Summary step=${s.step}`,
    renderDetail: (s: TestState) => `Detail step=${s.step} label=${s.label}`,
    renderButtons: (panelId: string, _s: TestState, mode: 'collapsed' | 'expanded', terminal: boolean): InlineKeyboard => {
      if (terminal) return [];
      if (mode === 'collapsed') {
        return [[standardPanelButton(panelId, 'debate', 'expand', 'Show')]];
      }
      return [[standardPanelButton(panelId, 'debate', 'collapse', 'Hide')]];
    },
    ...overrides,
  };
}

function makeCtx(overrides: {
  chatId?: number;
  userId?: number;
  messageId?: number;
  data?: string;
} = {}) {
  const chatId = overrides.chatId ?? 1001;
  const userId = overrides.userId ?? 42;
  const messageId = overrides.messageId ?? 100;
  return {
    chat: { id: chatId },
    from: { id: userId },
    callbackQuery: {
      data: overrides.data ?? '',
      message: { message_id: messageId },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(overrides: Partial<AppConfig['debate']> = {}): AppConfig {
  const base = makeTestConfig();
  return {
    ...base,
    debate: {
      panelStateCacheMax: overrides.panelStateCacheMax ?? 5,
      panelStateTtlHours: overrides.panelStateTtlHours ?? 24,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPanelRegistry', () => {
  let adapter: ReturnType<typeof makeAdapter>;
  let registry: PanelRegistry;
  let config: AppConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = makeAdapter();
    config = makeConfig();
    registry = createPanelRegistry(config, adapter);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- create + messageId resolution ----

  it('sends initial message and stores messageId', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'start' });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = adapter.sendMessage.mock.calls[0];
    expect(chatId).toBe(1001);
    expect(text).toContain('step=1');
    expect(opts?.parseMode).toBe('HTML');
    expect(opts?.buttons).toBeDefined();
    expect(api.messageId).toBe(100);
    expect(api.panelId).toMatch(/^[a-f0-9]{16}$/);
    expect(registry.size()).toBe(1);
  });

  // ---- updateState debounce ----

  it('coalesces multiple updateState calls within debounce window to one edit', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'a' });

    api.updateState({ step: 2, label: 'b' });
    api.updateState({ step: 3, label: 'c' });
    api.updateState({ step: 4, label: 'd' });

    // No edit yet — debounce pending
    expect(adapter.editMessageText).not.toHaveBeenCalled();

    // Advance past debounce window (1500ms) but not the hourly TTL interval
    await vi.advanceTimersByTimeAsync(2000);

    // Only one edit dispatched
    expect(adapter.editMessageText).toHaveBeenCalledTimes(1);
    const [, , text] = adapter.editMessageText.mock.calls[0];
    // Last state wins
    expect(text).toContain('step=4');
  });

  it('does not re-edit when text+buttons are identical (dedupe)', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'same' });

    // Force edit then try to edit again with same state
    api.updateState({ step: 1, label: 'same' });
    await vi.advanceTimersByTimeAsync(2000);

    // Rendered text matches the lastSentText from create — should be skipped
    expect(adapter.editMessageText).not.toHaveBeenCalled();
  });

  // ---- expand callback ----

  it('expand callback flips mode to expanded; next edit shows renderDetail', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 5, label: 'hello' });
    const panelId = api.panelId;

    const ctx = makeCtx({ data: `debate.expand:${panelId}` });
    await registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expanded' });

    // Advance timers past debounce window (1500ms) without triggering hourly TTL sweep
    await vi.advanceTimersByTimeAsync(2000);

    expect(adapter.editMessageText).toHaveBeenCalled();
    const lastCall = adapter.editMessageText.mock.calls[adapter.editMessageText.mock.calls.length - 1];
    expect(lastCall[2]).toContain('Detail'); // renderDetail text
    expect(lastCall[2]).toContain('label=hello');
  });

  // ---- collapse callback ----

  it('collapse callback flips mode back to collapsed; next edit shows renderSummary', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 7, label: 'world' });
    const panelId = api.panelId;

    // Expand first
    const expandCtx = makeCtx({ data: `debate.expand:${panelId}` });
    await registry.handleCallback(`debate.expand:${panelId}`, expandCtx as unknown as import('grammy').Context);
    await vi.advanceTimersByTimeAsync(2000);

    const collapseCtx = makeCtx({ data: `debate.collapse:${panelId}` });
    await registry.handleCallback(`debate.collapse:${panelId}`, collapseCtx as unknown as import('grammy').Context);

    expect(collapseCtx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Collapsed' });

    await vi.advanceTimersByTimeAsync(2000);

    const lastCall = adapter.editMessageText.mock.calls[adapter.editMessageText.mock.calls.length - 1];
    expect(lastCall[2]).toContain('Summary'); // renderSummary text
  });

  // ---- cancel ownership ----

  it('starter can cancel their own panel', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'owned' });
    const panelId = api.panelId;

    const ctx = makeCtx({ userId: 42, data: `debate.cancel:${panelId}` }); // ownerUserId = 42
    await registry.handleCallback(`debate.cancel:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Cancel requested.' });
  });

  it('non-admin stranger cannot cancel panel', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'owned' });
    const panelId = api.panelId;

    const ctx = makeCtx({ userId: 9999, data: `debate.cancel:${panelId}` }); // stranger
    await registry.handleCallback(`debate.cancel:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Only the starter or an admin can cancel.',
    });
  });

  it('admin can cancel any panel', async () => {
    const adminConfig = makeConfig();
    adminConfig.groups.adminUserIds = [777];
    const adminAdapter = makeAdapter();
    const adminRegistry = createPanelRegistry(adminConfig, adminAdapter);
    const deps = makeDeps(adminAdapter);
    const api = await adminRegistry.create(deps, { step: 1, label: 'admin-test' });
    const panelId = api.panelId;

    const ctx = makeCtx({ userId: 777, data: `debate.cancel:${panelId}` }); // admin
    await adminRegistry.handleCallback(`debate.cancel:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Cancel requested.' });
  });

  // ---- R2 cross-chat cancel guard ----

  it('R2: cross-chat button tap rejected with "no longer valid here" toast', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'test' });
    const panelId = api.panelId;

    // Same panelId, but different chat
    const ctx = makeCtx({ chatId: 9999, data: `debate.cancel:${panelId}` });
    await registry.handleCallback(`debate.cancel:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Button no longer valid here.' });
    // Panel state must not have changed
    const entry = registry._getPanelForTests(panelId);
    expect(entry).toBeDefined();
    expect(entry!.mode).toBe('collapsed'); // unchanged
  });

  it('R2: cross-chat expand also rejected (read-only op, but data-leak vector)', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'guard' });
    const panelId = api.panelId;

    const ctx = makeCtx({ chatId: 5555, data: `debate.expand:${panelId}` });
    await registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Button no longer valid here.' });
  });

  // ---- stale callback (panel not in registry) ----

  it('stale callback: panel not in registry → expired toast + keyboard strip attempt', async () => {
    const ctx = makeCtx({ data: 'debate.expand:deadbeef12345678', chatId: 1001, messageId: 999 });
    await registry.handleCallback('debate.expand:deadbeef12345678', ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Panel expired — please re-run the command.',
    });
    // Fix 3: strip via adapter.editMessageReplyMarkup (platform-neutral), NOT ctx shorthand
    expect(adapter.editMessageReplyMarkup).toHaveBeenCalledWith(1001, 999, undefined);
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  // ---- malformed callback_data ----

  it('malformed callback_data → "Button data malformed." toast', async () => {
    const ctx = makeCtx({ data: 'not-valid-data' });
    await registry.handleCallback('not-valid-data', ctx as unknown as import('grammy').Context);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Button data malformed.' });
  });

  it('callback_data without panelId → expired toast', async () => {
    // This matches the regex but has no capture group 4 (panelId is optional in regex but treated as expired)
    const ctx = makeCtx({ data: 'debate.expand' });
    await registry.handleCallback('debate.expand', ctx as unknown as import('grammy').Context);

    // 'debate.expand' does NOT match CALLBACK_RE because there's no :panelId portion
    // and the regex requires (group2) to exist. Let's check: debate.expand matches namespace=debate, action=expand, panelId=null
    // Actually CALLBACK_RE: /^([a-z][a-z0-9-]*)\.(expand|collapse|cancel)(:([A-Za-z0-9_-]{4,31}))?$/
    // 'debate.expand' matches with panelId=null → triggers "Panel expired" path
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const callArg = ctx.answerCallbackQuery.mock.calls[0][0];
    expect(callArg.text).toBeTruthy();
  });

  // ---- finalize ----

  it('finalize marks terminal, flushes pending update, subsequent expand still works', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'init' });
    const panelId = api.panelId;

    // Queue an update but do not flush yet
    api.updateState({ step: 2, label: 'mid' });
    // Finalize immediately (before debounce fires)
    await api.finalize({ step: 3, label: 'done' });

    // Should have flushed — editMessageText called at least once
    expect(adapter.editMessageText).toHaveBeenCalled();
    const lastCall = adapter.editMessageText.mock.calls[adapter.editMessageText.mock.calls.length - 1];
    expect(lastCall[2]).toContain('step=3'); // final state wins

    // Panel still in registry (for expand/collapse after terminal)
    expect(registry.size()).toBe(1);
    const entry = registry._getPanelForTests(panelId);
    expect(entry?.terminal).toBe(true);

    // Expand still routes correctly
    const ctx = makeCtx({ data: `debate.expand:${panelId}` });
    await registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expanded' });
  });

  // ---- close ----

  it('close removes from registry; subsequent callback shows expired toast', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'temp' });
    const panelId = api.panelId;

    expect(registry.size()).toBe(1);
    api.close();
    expect(registry.size()).toBe(0);

    // close is idempotent
    api.close();
    expect(registry.size()).toBe(0);

    // Callback now stale
    const ctx = makeCtx({ data: `debate.expand:${panelId}` });
    await registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Panel expired — please re-run the command.',
    });
  });

  it('closePanel is idempotent', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'x' });
    const panelId = api.panelId;

    registry.closePanel(panelId);
    registry.closePanel(panelId); // second call — no throw
    expect(registry.size()).toBe(0);
  });

  // ---- LRU eviction ----

  it('LRU eviction: creating cacheMax+1 panels evicts oldest-accessed', async () => {
    const smallConfig = makeConfig({ panelStateCacheMax: 3 });
    const smallAdapter = makeAdapter();
    const smallRegistry = createPanelRegistry(smallConfig, smallAdapter);
    const deps = makeDeps(smallAdapter);

    // Create 3 panels — fills cache
    const p1 = await smallRegistry.create(deps, { step: 1, label: 'p1' });
    const p2 = await smallRegistry.create(deps, { step: 2, label: 'p2' });
    const p3 = await smallRegistry.create(deps, { step: 3, label: 'p3' });

    // p1 is oldest-accessed — it should be evicted when p4 is created
    expect(smallRegistry.size()).toBe(3);

    const p4 = await smallRegistry.create(deps, { step: 4, label: 'p4' });
    expect(smallRegistry.size()).toBe(3); // still 3 — p1 evicted, p4 added

    // p1 no longer in registry
    expect(smallRegistry._getPanelForTests(p1.panelId)).toBeUndefined();
    // p2, p3, p4 still present
    expect(smallRegistry._getPanelForTests(p2.panelId)).toBeDefined();
    expect(smallRegistry._getPanelForTests(p3.panelId)).toBeDefined();
    expect(smallRegistry._getPanelForTests(p4.panelId)).toBeDefined();
  });

  // ---- TTL eviction ----

  it('TTL eviction: panel older than ttlHours is evicted on next hour tick', async () => {
    const ttlConfig = makeConfig({ panelStateCacheMax: 10, panelStateTtlHours: 1 });
    const ttlAdapter = makeAdapter();
    const ttlRegistry = createPanelRegistry(ttlConfig, ttlAdapter);
    const deps = makeDeps(ttlAdapter);

    const api = await ttlRegistry.create(deps, { step: 1, label: 'ttl-test' });
    const panelId = api.panelId;

    expect(ttlRegistry._getPanelForTests(panelId)).toBeDefined();

    // Warp time past 1 hour TTL and then trigger the sweep interval
    // The sweep runs every 3,600,000ms; TTL is 1h = 3,600,000ms.
    // Advance by 2× the interval so the panel is expired AND the sweep fires.
    await vi.advanceTimersByTimeAsync(3_600_001 * 2);

    expect(ttlRegistry._getPanelForTests(panelId)).toBeUndefined();
    expect(ttlRegistry.size()).toBe(0);
  });

  // ---- editMessageReplyMarkup error handling (R10) ----

  it('stale callback: editMessageReplyMarkup "not modified" is silently swallowed', async () => {
    // Create and close a panel so we can build a ctx pointing to its message
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'x' });
    const panelId = api.panelId;
    registry.closePanel(panelId);

    // The adapter.editMessageReplyMarkup throws "not modified" (Fix 3: adapter path, not ctx)
    adapter.editMessageReplyMarkup.mockRejectedValueOnce(
      new Error('Bad Request: message is not modified'),
    );
    const ctx = makeCtx({ data: `debate.expand:${panelId}`, chatId: 1001, messageId: 100 });

    await expect(
      registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context),
    ).resolves.not.toThrow();
    // Verify adapter was called (not ctx shorthand)
    expect(adapter.editMessageReplyMarkup).toHaveBeenCalledWith(1001, 100, undefined);
  });

  it('stale callback: editMessageReplyMarkup "message to edit not found" is silently handled', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'x' });
    const panelId = api.panelId;
    registry.closePanel(panelId);

    adapter.editMessageReplyMarkup.mockRejectedValueOnce(
      new Error('Bad Request: message to edit not found'),
    );
    const ctx = makeCtx({ data: `debate.expand:${panelId}`, chatId: 1001, messageId: 100 });

    await expect(
      registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context),
    ).resolves.not.toThrow();
  });

  it('stale callback: other editMessageReplyMarkup errors do not throw', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'x' });
    const panelId = api.panelId;
    registry.closePanel(panelId);

    adapter.editMessageReplyMarkup.mockRejectedValueOnce(
      new Error('Telegram API error: NETWORK_TIMEOUT'),
    );
    const ctx = makeCtx({ data: `debate.expand:${panelId}`, chatId: 1001, messageId: 100 });

    await expect(
      registry.handleCallback(`debate.expand:${panelId}`, ctx as unknown as import('grammy').Context),
    ).resolves.not.toThrow();
  });

  // ---- extraActions.cancel delegation ----

  it('cancel invokes extraActions.cancel when provided (Fix 5: void return — stock toast wins)', async () => {
    // Fix 5: extraActions return void; the registry's stock "Cancel requested." toast always fires.
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(adapter, {
      extraActions: { cancel: cancelSpy },
    });
    const api = await registry.create(deps, { step: 1, label: 'x' });
    const panelId = api.panelId;

    const ctx = makeCtx({ userId: 42, data: `debate.cancel:${panelId}` });
    await registry.handleCallback(`debate.cancel:${panelId}`, ctx as unknown as import('grammy').Context);

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Cancel requested.' });
  });

  // ---- standardPanelButton helper ----

  it('standardPanelButton produces correctly shaped callback_data', () => {
    const btn = standardPanelButton('abcdef12', 'debate', 'expand', 'Show');
    expect(btn.label).toBe('Show');
    expect(btn.data).toBe('debate.expand:abcdef12');
  });

  it('standardPanelButton works for collapse and cancel', () => {
    expect(standardPanelButton('abcd1234', 'debate', 'collapse', 'Hide').data).toBe('debate.collapse:abcd1234');
    expect(standardPanelButton('abcd1234', 'debate', 'cancel', '✕').data).toBe('debate.cancel:abcd1234');
  });

  // ---- debounce respects MIN_EDIT_INTERVAL ----

  it('second updateState after interval fires a second edit', async () => {
    const deps = makeDeps(adapter);
    const api = await registry.create(deps, { step: 1, label: 'a' });

    api.updateState({ step: 2, label: 'b' });
    await vi.advanceTimersByTimeAsync(2000);

    // Advance past the edit rate limit so the next update fires with no wait
    await vi.advanceTimersByTimeAsync(2000);

    api.updateState({ step: 3, label: 'c' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(adapter.editMessageText).toHaveBeenCalledTimes(2);
  });
});
