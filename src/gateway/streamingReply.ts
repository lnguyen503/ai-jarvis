/**
 * StreamingReply — a per-turn helper that surfaces token-by-token output to
 * the chat via debounced Telegram editMessageText calls (v1.12.0).
 *
 * Lifecycle:
 *   const reply = createStreamingReply({adapter, chatId, editIntervalMs, logger});
 *   ...pass reply.onTextDelta + reply.onProviderCallStart to agent.turn...
 *   await reply.finalize(finalReplyText, htmlConverter);  // or .abandon() on error
 *
 * Design:
 *   - First onTextDelta sends the initial placeholder message and records the
 *     messageId. Subsequent deltas append to an in-memory buffer and fire a
 *     debounced editMessageText no more often than editIntervalMs. We do NOT
 *     edit per token (Telegram's rate limit is ~1/sec per chat; we sit under
 *     500ms to stay safe).
 *   - Mid-stream text is sent as PLAIN TEXT — we do the HTML-markdown
 *     conversion only once at finalize() time. Converting partial markdown
 *     mid-stream would render incomplete syntax (`**bol`) incorrectly.
 *   - onProviderCallStart resets the buffer. Between tool-use and end_turn
 *     iterations of the ReAct loop, the LLM produces preamble text the user
 *     shouldn't see concatenated with the final answer. Reset ensures the
 *     visible message shows only the most recent call's accumulating text.
 *   - finalize(text) does one last edit with the HTML-converted final text.
 *     That text is authoritative — the turn result's replyText — not the
 *     accumulated buffer (which can be stale vs. the agent's post-processing
 *     like group scrubbing or escalation prefixes).
 *   - abandon() is the failure path. Caller uses it when streaming started
 *     but the turn threw. We do not delete the partial message (no sendMessage
 *     path-rollback); caller can edit it to an error string after abandon()
 *     returns the messageId.
 *
 * Safe under:
 *   - Abort mid-stream: the SDKs throw; finalize() is never called; the user
 *     sees the last buffered content. Caller should call abandon() and edit
 *     with a "[stopped]" suffix if it wants.
 *   - Telegram 'message is not modified' error (identical text): swallowed
 *     by dedupe check before the edit fires.
 *   - 429 on edit: swallowed by the catch around each editMessageText. We
 *     skip the failed edit; the next debounce tick tries again.
 *
 * One StreamingReply per agent.turn. Don't reuse across turns.
 */

import type { MessagingAdapter } from '../messaging/adapter.js';
import { child as childLogger } from '../logger/index.js';

export interface StreamingReplyDeps {
  adapter: MessagingAdapter;
  chatId: number;
  editIntervalMs: number;
  /** Minimum chars between edits — defence against editing on every single-token arrival.
   *  Defaults to 1 (edit on any change). Set higher to coalesce chunks. */
  minCharsBetweenEdits?: number;
  /** Cursor character appended to the live buffer during streaming (removed at finalize).
   *  Empty string disables the cursor. Default: '▍'. */
  cursor?: string;
}

export interface StreamingReply {
  onTextDelta: (chunk: string) => void;
  onProviderCallStart: () => void;
  /** Do a final edit with `text` (HTML parse mode). If streaming never started, sends fresh. */
  finalize(htmlText: string): Promise<void>;
  /** Abandon streaming. Returns messageId if one was created, else null. Does NOT delete. */
  abandon(): number | null;
  /** Has a message been sent yet? */
  hasStarted(): boolean;
}

const log = childLogger({ component: 'gateway.streamingReply' });

export function createStreamingReply(deps: StreamingReplyDeps): StreamingReply {
  const { adapter, chatId, editIntervalMs } = deps;
  const minChars = deps.minCharsBetweenEdits ?? 1;
  const cursor = deps.cursor ?? '▍';

  let messageId: number | null = null;
  // Buffer for the CURRENT provider call. Cleared on onProviderCallStart.
  let buffer = '';
  // Last text we sent to Telegram (so we can skip identical edits).
  let lastSentText = '';
  // Last edit timestamp for debounce.
  let lastEditAt = 0;
  // Pending edit timer — fires when the debounce window elapses if a delta
  // arrived mid-window.
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Are we currently in an editMessageText call? Guard against overlap.
  let editInFlight = false;
  // Finalized — no more deltas accepted.
  let finalized = false;

  function scheduleEdit(): void {
    if (finalized) return;
    if (pendingTimer !== null) return;  // already scheduled
    const elapsed = Date.now() - lastEditAt;
    const delay = Math.max(0, editIntervalMs - elapsed);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void attemptEdit();
    }, delay);
  }

  async function attemptEdit(): Promise<void> {
    if (finalized) return;
    if (editInFlight) {
      // Another edit just fired; let it finish, schedule a follow-up.
      scheduleEdit();
      return;
    }
    const current = buffer;
    // Append the cursor to the visible text during streaming so paused
    // moments still read as "still typing" rather than "done."
    const visible = current.length > 0 && cursor.length > 0
      ? `${current}${cursor}`
      : current;
    // Dedupe — Telegram rejects identical-text edits with an error we'd rather avoid paying for.
    if (visible === lastSentText) return;
    if (visible.length === 0) return;
    // Telegram plain-text message limit is 4096 chars. Truncate intermediate
    // edits; the final edit does proper splitting if needed.
    const truncated = visible.length > 4000 ? `${visible.slice(0, 4000)}…` : visible;

    editInFlight = true;
    try {
      if (messageId === null) {
        const sent = await adapter.sendMessage(chatId, truncated);
        messageId = sent.messageId;
      } else {
        await adapter.editMessageText(chatId, messageId, truncated);
      }
      lastSentText = visible;
      lastEditAt = Date.now();
    } catch (err) {
      // 429 / 400 "message is not modified" / other transient edit errors:
      // log at debug and keep going. The next buffered delta will retry.
      log.debug(
        { chatId, err: err instanceof Error ? err.message : String(err) },
        'streaming edit failed (non-fatal)',
      );
    } finally {
      editInFlight = false;
    }
  }

  return {
    hasStarted() {
      return messageId !== null;
    },

    onTextDelta(chunk: string): void {
      if (finalized) return;
      buffer += chunk;
      // If we haven't sent the initial message yet and we have something to send, fire immediately.
      if (messageId === null && buffer.length >= 1) {
        void attemptEdit();
        return;
      }
      // Debounced edit when buffer has grown enough since last send.
      if (buffer.length - lastSentText.length >= minChars) {
        scheduleEdit();
      }
    },

    onProviderCallStart(): void {
      if (finalized) return;
      // Reset the buffer — the new provider call generates fresh text that
      // should replace, not append to, any preamble from the prior call.
      buffer = '';
      // Don't reset lastSentText — we leave the visible message alone until
      // the new call actually streams content (avoids a flash-of-empty).
    },

    async finalize(htmlText: string): Promise<void> {
      finalized = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      // Wait for any in-flight edit to complete so our final edit isn't
      // overwritten by a lingering intermediate one.
      for (let i = 0; i < 20 && editInFlight; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      try {
        if (messageId === null) {
          // Streaming never started (zero deltas — e.g. tool-only turn with
          // no text output, or provider bypassed streaming). Send fresh.
          await adapter.sendMessage(chatId, htmlText, { parseMode: 'HTML' });
        } else {
          await adapter.editMessageText(chatId, messageId, htmlText, { parseMode: 'HTML' });
        }
      } catch (err) {
        // HTML edit failed (usually an HTML-parse error from the converter
        // emitting something Telegram rejects). Fall back to plain text.
        log.warn(
          { chatId, err: err instanceof Error ? err.message : String(err) },
          'streaming finalize HTML edit failed; falling back to plain text',
        );
        if (messageId === null) {
          await adapter.sendMessage(chatId, htmlText).catch(() => {});
        } else {
          await adapter.editMessageText(chatId, messageId, htmlText).catch(() => {});
        }
      }
    },

    abandon(): number | null {
      finalized = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      return messageId;
    },
  };
}
