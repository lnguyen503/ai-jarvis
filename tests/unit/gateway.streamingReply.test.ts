/**
 * Tests for src/gateway/streamingReply.ts — the per-turn helper that
 * buffers text deltas and issues debounced edits via the MessagingAdapter.
 *
 * Using vitest's fake timers so we can verify the debounce window without
 * real sleeps. adapter is a mock with recorded calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MessagingAdapter } from '../../src/messaging/adapter.js';
import { createStreamingReply } from '../../src/gateway/streamingReply.js';

function makeMockAdapter() {
  const sendMessage = vi.fn(async (_chatId: number, text: string) => ({
    messageId: 100,
  }));
  const editMessageText = vi.fn(async () => {});
  const sendDocument = vi.fn(async () => ({ messageId: 200 }));
  const sendPhoto = vi.fn(async () => ({ messageId: 300 }));
  const sendVoice = vi.fn(async () => ({ messageId: 400 }));
  const sendChatAction = vi.fn(async () => {});
  const resolveDmChatId = vi.fn(() => null);

  const adapter: MessagingAdapter = {
    sendMessage,
    editMessageText,
    sendDocument,
    sendPhoto,
    sendVoice,
    sendChatAction,
    resolveDmChatId,
  };

  return {
    adapter,
    sendMessage,
    editMessageText,
  };
}

describe('streamingReply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends initial message on first delta', async () => {
    const { adapter, sendMessage } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 123,
      editIntervalMs: 500,
      cursor: '',
    });

    expect(reply.hasStarted()).toBe(false);
    reply.onTextDelta('Hello');
    // attemptEdit is fire-and-forget; wait for the promise microtask.
    await vi.runAllTimersAsync();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toBe(123);
    expect(sendMessage.mock.calls[0]?.[1]).toBe('Hello');
    expect(reply.hasStarted()).toBe(true);
  });

  it('debounces edits to the configured interval', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 500,
      minCharsBetweenEdits: 1,
      cursor: '',
    });

    reply.onTextDelta('One');
    await vi.runAllTimersAsync();  // initial send fires
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Rapid deltas within the debounce window should NOT trigger per-delta edits.
    reply.onTextDelta(' Two');
    reply.onTextDelta(' Three');
    reply.onTextDelta(' Four');

    // Before the debounce elapses: no edit fired yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(editMessageText).toHaveBeenCalledTimes(0);

    // After the debounce window: one edit with the accumulated buffer.
    await vi.advanceTimersByTimeAsync(500);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText.mock.calls[0]?.[2]).toBe('One Two Three Four');
  });

  it('skips identical-content edits', async () => {
    const { adapter, editMessageText } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 100,
      minCharsBetweenEdits: 1,
      cursor: '',
    });

    reply.onTextDelta('A');
    await vi.runAllTimersAsync();
    // First attempted edit does nothing further; no new delta → nothing to send
    await vi.advanceTimersByTimeAsync(500);
    expect(editMessageText).toHaveBeenCalledTimes(0);  // no subsequent edit
  });

  it('resets buffer on onProviderCallStart', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 100,
      minCharsBetweenEdits: 1,
      cursor: '',
    });

    reply.onTextDelta('preamble');
    await vi.runAllTimersAsync();
    expect(sendMessage).toHaveBeenCalledOnce();

    // Simulate tool_use iteration boundary — buffer resets.
    reply.onProviderCallStart();

    reply.onTextDelta('final answer');
    await vi.advanceTimersByTimeAsync(200);

    // The LATEST edit should have "final answer" (not "preamblefinal answer").
    const lastCall = editMessageText.mock.calls[editMessageText.mock.calls.length - 1];
    expect(lastCall?.[2]).toBe('final answer');
  });

  it('finalize sends HTML-formatted text when streaming started', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 500,
      cursor: '',
    });

    reply.onTextDelta('some text');
    await vi.runAllTimersAsync();
    expect(sendMessage).toHaveBeenCalledOnce();

    await reply.finalize('<b>Hello</b>');
    expect(editMessageText).toHaveBeenCalled();
    const last = editMessageText.mock.calls[editMessageText.mock.calls.length - 1];
    expect(last?.[2]).toBe('<b>Hello</b>');
    expect(last?.[3]).toEqual({ parseMode: 'HTML' });
  });

  it('finalize sends fresh message when streaming never started (tool-only turn)', async () => {
    const { adapter, sendMessage } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 500,
      cursor: '',
    });

    // No onTextDelta called — zero chunks from provider.
    await reply.finalize('<b>Result</b>');
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ parseMode: 'HTML' });
  });

  it('finalize falls back to plain text when HTML edit rejected', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    // First delta triggers initial send (OK), later HTML edit fails once, plain
    // retry succeeds.
    editMessageText.mockImplementationOnce(async () => {
      throw new Error('can\'t parse entities: unexpected end tag');
    });
    editMessageText.mockImplementationOnce(async () => {});  // plain retry

    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 500,
      cursor: '',
    });

    reply.onTextDelta('x');
    await vi.runAllTimersAsync();

    await reply.finalize('<b>bad html');

    // Two edit attempts: HTML (fails), plain (works).
    expect(editMessageText).toHaveBeenCalledTimes(2);
    // Second call has no parseMode (plain-text fallback).
    const second = editMessageText.mock.calls[1];
    expect(second?.[3]).toBeUndefined();
  });

  it('abandon returns messageId if streaming started, null otherwise', async () => {
    const { adapter, sendMessage } = makeMockAdapter();
    sendMessage.mockResolvedValue({ messageId: 777 });

    const r1 = createStreamingReply({ adapter, chatId: 1, editIntervalMs: 500 });
    expect(r1.abandon()).toBe(null);

    const r2 = createStreamingReply({ adapter, chatId: 1, editIntervalMs: 500 });
    r2.onTextDelta('x');
    await vi.runAllTimersAsync();
    expect(r2.abandon()).toBe(777);
  });

  it('non-fatal edit errors do not break the stream', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    // Every intermediate edit throws 429; final finalize works.
    editMessageText.mockImplementation(async () => {
      throw new Error('429 Too Many Requests');
    });

    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 100,
      minCharsBetweenEdits: 1,
      cursor: '',
    });

    reply.onTextDelta('A');
    await vi.runAllTimersAsync();
    reply.onTextDelta('B');
    await vi.advanceTimersByTimeAsync(200);
    reply.onTextDelta('C');
    await vi.advanceTimersByTimeAsync(200);

    // Stream still "alive" — no throw surfaced to the caller.
    expect(reply.hasStarted()).toBe(true);

    // finalize with plain text still executes (even though the HTML path will
    // throw and fall back to plain, which also throws — all swallowed).
    await expect(reply.finalize('done')).resolves.toBeUndefined();
  });

  it('after finalize, further deltas are ignored', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 500,
      cursor: '',
    });

    reply.onTextDelta('hi');
    await vi.runAllTimersAsync();
    await reply.finalize('final');
    const editsBefore = editMessageText.mock.calls.length;

    reply.onTextDelta('late chunk');
    await vi.advanceTimersByTimeAsync(1000);

    // No new edits fired after finalize.
    expect(editMessageText.mock.calls.length).toBe(editsBefore);
  });

  it('truncates oversized buffers for intermediate edits', async () => {
    const { adapter, sendMessage } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 500,
      cursor: '',
    });

    const big = 'x'.repeat(5000);
    reply.onTextDelta(big);
    await vi.runAllTimersAsync();

    // Initial send was called with a truncated version (4000 chars + ellipsis).
    const sentText = sendMessage.mock.calls[0]?.[1] as string;
    expect(sentText.length).toBeLessThanOrEqual(4001);
    expect(sentText.endsWith('…')).toBe(true);
  });

  it('appends cursor to the live buffer during streaming', async () => {
    const { adapter, sendMessage, editMessageText } = makeMockAdapter();
    const reply = createStreamingReply({
      adapter,
      chatId: 1,
      editIntervalMs: 100,
      minCharsBetweenEdits: 1,
      cursor: '▍',
    });

    reply.onTextDelta('Hello');
    await vi.runAllTimersAsync();
    expect(sendMessage.mock.calls[0]?.[1]).toBe('Hello▍');

    reply.onTextDelta(' world');
    await vi.advanceTimersByTimeAsync(200);
    const lastEdit = editMessageText.mock.calls[editMessageText.mock.calls.length - 1];
    expect(lastEdit?.[2]).toBe('Hello world▍');

    // Finalize passes the clean HTML-converted text; cursor not appended.
    await reply.finalize('<b>Hello world</b>');
    const finalEdit = editMessageText.mock.calls[editMessageText.mock.calls.length - 1];
    expect(finalEdit?.[2]).toBe('<b>Hello world</b>');
    expect(finalEdit?.[2]).not.toContain('▍');
  });
});
