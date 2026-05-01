/**
 * Generic ProgressPanel primitive — v1.12.0.
 *
 * A state-type-parameterised progress panel that handles initial send,
 * debounced edits, collapse/expand state, terminal finalisation, and callback
 * dispatch. Consumers supply render callbacks and state; the primitive owns
 * the messaging-adapter mechanics.
 *
 * Allowed imports: node:crypto, src/logger, src/messaging/adapter, src/config, grammy Context type.
 * Forbidden: src/agent, src/tools, src/commands, src/memory, src/organize, src/debate.
 *
 * See ADR 007 + 007-revisions-after-cp1.md for full design rationale.
 */

import { randomBytes } from 'node:crypto';
import type { Context } from 'grammy';
import type { MessagingAdapter, InlineKeyboard, InlineButton } from '../messaging/adapter.js';
import { child } from '../logger/index.js';
import type { AppConfig } from '../config/index.js';

const log = child({ component: 'gateway.progressPanel' });

const MIN_EDIT_INTERVAL_MS = 1500;

// R11 — callback_data regex: namespace.action:panelId
// namespace: [a-z][a-z0-9-]*
// action:    expand | collapse | cancel
// panelId:   optional; 4–31 chars of [A-Za-z0-9_-]
const CALLBACK_RE = /^([a-z][a-z0-9-]*)\.(expand|collapse|cancel)(:([A-Za-z0-9_-]{4,31}))?$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProgressPanelDeps<S> {
  adapter: MessagingAdapter;
  chatId: number;
  ownerUserId: number;
  /** e.g. 'debate'. Used for routing — callbacks shaped `<namespace>.<action>:<panelId>`. */
  callbackNamespace: string;
  /** Used in log context. e.g. 'debate'. */
  componentTag: string;
  renderSummary(state: S): string;
  renderDetail(state: S): string;
  /**
   * R3/R9 — panelId is the FIRST parameter. No currying.
   * Returns the full InlineKeyboard; the primitive does NOT inject buttons.
   */
  renderButtons(
    panelId: string,
    state: S,
    mode: 'collapsed' | 'expanded',
    terminal: boolean,
  ): InlineKeyboard;
  /**
   * Additional callback actions beyond expand/collapse/cancel.
   * Keys are action names; these are NOT routed by CALLBACK_RE (which only
   * handles the three built-ins). Extra actions must use a separate namespace
   * pattern if needed outside this primitive. Provided as extensibility seam —
   * e.g. `cancel` here receives the call after the auth guard passes.
   *
   * Return type is void — the registry answers its own stock toast before invoking
   * the handler, so the consumer's return value is intentionally discarded.
   */
  extraActions?: Record<string, (ctx: Context, state: S) => Promise<void>>;
}

export interface ProgressPanelApi<S> {
  readonly panelId: string;
  /** Resolved after create() — set to 0 before the initial send returns. */
  messageId: number;
  /** Debounced state update. Coalesces rapid calls to one edit per ~1500ms. */
  updateState(state: S): void;
  /** Mark terminal, flush pending debounce, do one synchronous final edit. */
  finalize(finalState: S): Promise<void>;
  /** Remove from registry and clear any pending debounce timer. Idempotent. */
  close(): void;
}

/** Internal panel entry stored in the LRU map. */
export interface PanelEntry {
  panelId: string;
  chatId: number;
  ownerUserId: number;
  messageId: number;
  namespace: string;
  mode: 'collapsed' | 'expanded';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  terminal: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: ProgressPanelDeps<any>;
  createdAt: number;
  lastAccessedAt: number;
  // Debounce state
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastEditAt: number;
  lastSentText: string | null;
  // In-flight promise to avoid concurrent sends
  inFlight: Promise<void> | null;
}

export interface PanelRegistry {
  /**
   * Create a new panel: send the initial message, register in the LRU map,
   * and return the API handle.
   */
  create<S>(deps: ProgressPanelDeps<S>, initialState: S): Promise<ProgressPanelApi<S>>;
  /**
   * Route a callback_query data string to the correct panel handler.
   * Handles expand/collapse/cancel built-ins. Stale/missing panels are
   * handled gracefully (expired toast + keyboard strip).
   */
  handleCallback(data: string, ctx: Context): Promise<void>;
  /**
   * Remove a panel from the registry and clear its debounce timer.
   * Idempotent — safe to call on an already-closed panel.
   */
  closePanel(panelId: string): void;
  /** Number of live panels. Useful for tests and metrics. */
  size(): number;
  /**
   * Test seam — returns the raw PanelEntry or undefined.
   * @testOnly Do not import from production code.
   */
  _getPanelForTests(panelId: string): PanelEntry | undefined;
}

// ---------------------------------------------------------------------------
// Helper — standardised button emission (R4)
// ---------------------------------------------------------------------------

/**
 * Build an InlineButton with a well-formed callback_data.
 * Consumers use this to avoid typo'd callback_data in renderButtons.
 */
export function standardPanelButton(
  panelId: string,
  namespace: string,
  action: 'expand' | 'collapse' | 'cancel',
  label: string,
): InlineButton {
  return { label, data: `${namespace}.${action}:${panelId}` };
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

export function createPanelRegistry(config: AppConfig, adapter: MessagingAdapter): PanelRegistry {
  const cacheMax = config.debate.panelStateCacheMax;
  const ttlMs = config.debate.panelStateTtlHours * 3_600_000;

  /** LRU: ordered by insertion; we re-insert on access to maintain order. */
  const panels = new Map<string, PanelEntry>();

  // Background TTL sweep — every hour. unref() so it doesn't keep the process alive.
  const ttlInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of panels) {
      if (now - entry.createdAt > ttlMs) {
        log.info(
          { panelId: id, component: entry.deps.componentTag, ageMs: now - entry.createdAt },
          'panel TTL eviction',
        );
        _closeEntry(id, entry);
      }
    }
  }, 3_600_000).unref();

  // Suppress TS "declared but never read" on the interval variable — it's
  // referenced through unref() and kept alive by the GC root.
  void ttlInterval;

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function _touch(entry: PanelEntry): void {
    entry.lastAccessedAt = Date.now();
  }

  function _evictOldestIfNeeded(): void {
    if (panels.size < cacheMax) return;
    // Find least-recently-accessed entry
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, entry] of panels) {
      if (entry.lastAccessedAt < oldestAt) {
        oldestAt = entry.lastAccessedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      const evicted = panels.get(oldestId)!;
      log.info(
        {
          panelId: oldestId,
          component: evicted.deps.componentTag,
          cacheMax,
          lastAccessedAt: new Date(evicted.lastAccessedAt).toISOString(),
        },
        'panel LRU eviction — cache at capacity',
      );
      _closeEntry(oldestId, evicted);
    }
  }

  function _closeEntry(panelId: string, entry: PanelEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    panels.delete(panelId);
  }

  /** Render the current text+buttons for a panel entry and push an edit. */
  async function _sendEdit(entry: PanelEntry): Promise<void> {
    const text =
      entry.mode === 'collapsed'
        ? (entry.deps.renderSummary(entry.state) as string)
        : (entry.deps.renderDetail(entry.state) as string);
    const buttons = entry.deps.renderButtons(
      entry.panelId,
      entry.state,
      entry.mode,
      entry.terminal,
    );
    const editHash = text + '|buttons:' + JSON.stringify(buttons);
    if (editHash === entry.lastSentText) return; // dedupe — Telegram rejects identical edits
    try {
      await entry.deps.adapter.editMessageText(entry.chatId, entry.messageId, text, {
        parseMode: 'HTML',
        buttons,
      });
      entry.lastSentText = editHash;
      entry.lastEditAt = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        log.warn(
          { chatId: entry.chatId, messageId: entry.messageId, err: msg, panelId: entry.panelId },
          'panel edit failed',
        );
      }
    }
  }

  /** Schedule a debounced edit. Mirrors plan/panel.ts:createPanelUpdater logic. */
  function _scheduleEdit(entry: PanelEntry): void {
    if (entry.debounceTimer) return; // already scheduled — coalesce
    const wait = Math.max(0, MIN_EDIT_INTERVAL_MS - (Date.now() - entry.lastEditAt));
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      entry.inFlight = _sendEdit(entry);
    }, wait);
  }

  /** Flush any pending debounce immediately, then do a synchronous send. */
  async function _flush(entry: PanelEntry): Promise<void> {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    if (entry.inFlight) await entry.inFlight;
    await _sendEdit(entry);
  }

  // ---------------------------------------------------------------------------
  // Public registry interface
  // ---------------------------------------------------------------------------

  return {
    async create<S>(deps: ProgressPanelDeps<S>, initialState: S): Promise<ProgressPanelApi<S>> {
      const panelId = randomBytes(8).toString('hex'); // 16-char hex; fits 4–31 char regex

      // Evict oldest if we are at capacity BEFORE adding the new entry
      _evictOldestIfNeeded();

      const now = Date.now();
      const entry: PanelEntry = {
        panelId,
        chatId: deps.chatId,
        ownerUserId: deps.ownerUserId,
        messageId: 0,
        namespace: deps.callbackNamespace,
        mode: 'collapsed',
        state: initialState,
        terminal: false,
        deps,
        createdAt: now,
        lastAccessedAt: now,
        debounceTimer: null,
        lastEditAt: 0,
        lastSentText: null,
        inFlight: null,
      };

      // Send initial message
      const text = deps.renderSummary(initialState);
      const buttons = deps.renderButtons(panelId, initialState, 'collapsed', false);
      const { messageId } = await deps.adapter.sendMessage(deps.chatId, text, {
        parseMode: 'HTML',
        buttons,
      });
      entry.messageId = messageId;
      entry.lastSentText = text + '|buttons:' + JSON.stringify(buttons);
      entry.lastEditAt = Date.now();

      panels.set(panelId, entry);

      log.info(
        { panelId, chatId: deps.chatId, messageId, component: deps.componentTag },
        'panel created',
      );

      // Build the API handle
      const api: ProgressPanelApi<S> = {
        get panelId() {
          return panelId;
        },
        get messageId() {
          return entry.messageId;
        },
        set messageId(v: number) {
          entry.messageId = v;
        },
        updateState(newState: S): void {
          const e = panels.get(panelId);
          if (!e) return; // already closed
          _touch(e);
          e.state = newState;
          _scheduleEdit(e);
        },
        async finalize(finalState: S): Promise<void> {
          const e = panels.get(panelId);
          if (!e) return;
          _touch(e);
          e.state = finalState;
          e.terminal = true;
          await _flush(e);
          // Keep in registry so expand/collapse still works after terminal.
        },
        close(): void {
          const e = panels.get(panelId);
          if (!e) return; // idempotent
          _closeEntry(panelId, e);
        },
      };

      return api;
    },

    async handleCallback(data: string, ctx: Context): Promise<void> {
      const m = CALLBACK_RE.exec(data);
      if (!m) {
        // Malformed — defense in depth. Should be unreachable in normal operation.
        await ctx.answerCallbackQuery({ text: 'Button data malformed.' }).catch(() => {});
        return;
      }

      const namespace = m[1]!;
      const action = m[2]! as 'expand' | 'collapse' | 'cancel';
      const panelId = m[4] ?? null;

      if (!panelId) {
        // No panel ID — stale or very old message.
        await ctx.answerCallbackQuery({ text: 'Panel expired — please re-run the command.' }).catch(() => {});
        return;
      }

      const entry = panels.get(panelId);

      if (!entry) {
        // Panel not in registry (expired or evicted).
        // Strip keyboard from the message — R10 distinguishing catch.
        await ctx.answerCallbackQuery({
          text: 'Panel expired — please re-run the command.',
        }).catch(() => {});
        const chatId = ctx.chat?.id;
        const messageId = ctx.callbackQuery?.message?.message_id;
        if (chatId != null && messageId != null) {
          // Use MessagingAdapter.editMessageReplyMarkup (platform-neutral) to strip keyboard.
          // R10: the adapter was added specifically for this use-case; prefer over grammY ctx shorthand.
          try {
            await adapter.editMessageReplyMarkup(chatId, messageId, undefined);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('message is not modified')) {
              // Already no keyboard — fine.
            } else if (msg.includes('message to edit not found') || msg.includes('MESSAGE_ID_INVALID')) {
              log.debug({ chatId, messageId, panelId }, 'stale panel message deleted by user');
            } else {
              log.warn({ chatId, messageId, panelId, err: msg }, 'strip keyboard failed for expired panel');
            }
          }
        }
        return;
      }

      _touch(entry);

      // R2 — cross-chat guard FIRST (forwarded-button attack defence)
      if (ctx.chat?.id !== entry.chatId) {
        await ctx.answerCallbackQuery({ text: 'Button no longer valid here.' }).catch(() => {});
        return;
      }

      // R2 — auth guard for cancel (expand/collapse are read-only — no auth beyond chat guard)
      if (action === 'cancel') {
        const userId = ctx.from?.id;
        if (userId === undefined) {
          await ctx.answerCallbackQuery({ text: 'No user context.' }).catch(() => {});
          return;
        }
        const isOwner = userId === entry.ownerUserId;
        const isAdmin =
          Array.isArray(config.groups?.adminUserIds) &&
          config.groups.adminUserIds.includes(userId);
        if (!isOwner && !isAdmin) {
          await ctx
            .answerCallbackQuery({ text: 'Only the starter or an admin can cancel.' })
            .catch(() => {});
          return;
        }
      }

      // Verify namespace matches the panel (defence: different panel type used same callback route)
      if (namespace !== entry.namespace) {
        await ctx.answerCallbackQuery({ text: 'Button no longer valid here.' }).catch(() => {});
        return;
      }

      // Dispatch
      switch (action) {
        case 'expand': {
          entry.mode = 'expanded';
          _scheduleEdit(entry);
          await ctx.answerCallbackQuery({ text: 'Expanded' }).catch(() => {});
          break;
        }
        case 'collapse': {
          entry.mode = 'collapsed';
          _scheduleEdit(entry);
          await ctx.answerCallbackQuery({ text: 'Collapsed' }).catch(() => {});
          break;
        }
        case 'cancel': {
          // Toast first, then delegate to consumer's extraActions.cancel if provided.
          await ctx.answerCallbackQuery({ text: 'Cancel requested.' }).catch(() => {});
          if (entry.deps.extraActions?.['cancel']) {
            try {
              await entry.deps.extraActions['cancel'](ctx, entry.state);
            } catch (err) {
              log.warn(
                { panelId, err: err instanceof Error ? err.message : String(err) },
                'extraActions.cancel threw',
              );
            }
          }
          // The primitive does NOT strip buttons or close the panel on cancel —
          // that is the consumer's responsibility via close() when the operation ends.
          break;
        }
      }
    },

    closePanel(panelId: string): void {
      const entry = panels.get(panelId);
      if (!entry) return;
      _closeEntry(panelId, entry);
    },

    size(): number {
      return panels.size;
    },

    // Test seam — documented as test-only; ESLint rule enforces import restriction.
    _getPanelForTests(panelId: string): PanelEntry | undefined {
      return panels.get(panelId);
    },
  };
}
