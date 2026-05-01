/**
 * Bot-to-bot loop protection (v1.21.0 D10; v1.22.0 simplified).
 *
 * Caps consecutive peer-bot turns per thread at MAX_BOT_TO_BOT_TURNS as a
 * runaway-loop safety net. The cap is the ONLY automatic stop in v1.22.0 —
 * the prior delivery-signal soft-termination was removed because the
 * orchestrator (Jarvis) now controls cadence by deciding when to @-mention
 * a specialist and when to post the deliverable.
 *
 * Reset triggers:
 *   - A USER (non-bot) message in the thread → reset immediately.
 *   - TTL expiry (1h) → auto-reset.
 *   - Process restart → in-memory state cleared.
 *
 * threadKey derivation:
 *   `<chatId>:<message_thread_id || firstMsgId>`
 *
 * Tests: tests/unit/gateway.loopProtection.test.ts
 *
 * ADR: ADR 021 D10.
 */

/**
 * Maximum consecutive bot-to-bot turns before protection engages.
 * v1.21.14: raised from 3 → 10. v1.22.0: kept at 10 as a runaway safety net.
 * v1.22.37: dropped 10 → 5. With smaller models we observed persona-drift
 * spirals (bots echoing "# Silence is the correct wrap." back at each other
 * for 8+ turns before the cap engaged). 5 catches drift earlier; the
 * orchestrator persona still controls normal cadence.
 */
export const MAX_BOT_TO_BOT_TURNS = 5;

/**
 * v1.22.45 — Tighter cap when no active plan exists.
 *
 * The default cap (5) accommodates legitimate plan-driven exchanges:
 * delegation @-mention → specialist reply → debate footer → orchestrator
 * acknowledgment → optional follow-up. Outside of a plan, anything past
 * 2 peer-bot turns is almost certainly drift (specialists chasing each
 * other into stale-context loops, as observed in plan #10's aftermath
 * where Tony, Natasha, Bruce kept responding to each other about the
 * old "team standup digest" task hours after delivery).
 *
 * Caller decides which cap applies by passing { hasActivePlan } to
 * checkBotToBotLoop.
 */
export const MAX_BOT_TO_BOT_TURNS_NO_PLAN = 2;

/**
 * v1.23.4 — sustained-banter cap. When the user explicitly invites a
 * back-and-forth chain ("keep going", "continue until I say stop", "take
 * turns") the 2-turn no-plan cap kills the chain after one round each.
 * Detected via the SUSTAINED_BANTER_REGEX below; the gateway sets a
 * per-thread "sustained" flag that raises the cap to 20 until the user
 * speaks again or says stop.
 *
 * Why 20: gives ~5 turns per bot in a 4-bot ensemble, which matches the
 * usual lifespan of a banter chain before the user redirects. The
 * existing user-stop signal (v1.22.8 STOP_KEYWORDS_REGEX) clears the
 * sustained flag immediately.
 */
export const MAX_BOT_TO_BOT_TURNS_SUSTAINED = 20;

/**
 * Regex matching user invitations to sustained banter. Case-insensitive.
 * False positives are recoverable (next user message resets the counter
 * regardless of sustained state).
 */
export const SUSTAINED_BANTER_REGEX =
  /\b(?:keep\s+going|keep\s+(?:it|the\s+banter)\s+going|continue\s+until|take\s+turns|round[- ]?robin|until\s+I\s+say\s+stop|until\s+i\s+stop\s+you)\b/i;

/** TTL for counters in milliseconds (1 hour). After this window without activity,
 *  the counter auto-resets even if no user message arrives. */
export const LOOP_COUNTER_TTL_MS = 3_600_000;

interface CounterEntry {
  count: number;
  updatedAt: number; // Unix ms
  /**
   * v1.22.8 — set when the user explicitly told the team to stop
   * ("stop" / "drop it" / "enough" / "that's all" / "we're done").
   * While set, peer-bot messages on this thread are dropped at the
   * gateway. Cleared by any non-stop user message.
   */
  stopped: boolean;
  /**
   * v1.23.4 — set when the user explicitly invited sustained banter
   * ("keep going", "continue until I say stop", "take turns"). While
   * set, the cap rises to MAX_BOT_TO_BOT_TURNS_SUSTAINED (20) instead
   * of the no-plan default (2). Cleared by any user message that does
   * NOT match SUSTAINED_BANTER_REGEX (which also resets the counter
   * via resetBotToBotCounterOnUserMessage).
   */
  sustained: boolean;
}

// Module-level in-memory store (ephemeral — no SQLite; reset on restart is safe).
const counters = new Map<string, CounterEntry>();

/**
 * Derive a stable thread key from a chat ID and optional thread discriminator.
 *
 * @param chatId  Telegram chat ID (negative for groups/supergroups)
 * @param threadId  Telegram `message_thread_id` for topic threads, OR the
 *                  `message_id` of the first message in a flat reply chain.
 *                  Pass `undefined` for non-threaded chats (counter is chat-scoped).
 */
export function deriveThreadKey(chatId: number, threadId: number | undefined): string {
  return threadId !== undefined ? `${chatId}:${threadId}` : `${chatId}`;
}

/**
 * Check whether this bot-to-bot turn is within the allowed cap.
 *
 * Returns `{ allowed: true, count }` if the turn should proceed.
 * Returns `{ allowed: false, count, reason: 'cap' }` if the cap is reached.
 *
 * A stale entry (older than TTL) is treated as if it never existed (auto-reset).
 */
export function checkBotToBotLoop(
  threadKey: string,
  nowMs: number = Date.now(),
  opts: { hasActivePlan?: boolean } = {},
): { allowed: boolean; count: number; cap: number; reason?: 'cap' | 'stopped' } {
  const entry = counters.get(threadKey);

  // v1.23.4 — sustained banter beats both with-plan and no-plan caps.
  // When the user invited "keep going"-style continuation, raise to 20.
  let cap: number;
  if (entry?.sustained) {
    cap = MAX_BOT_TO_BOT_TURNS_SUSTAINED;
  } else {
    cap = opts.hasActivePlan === false ? MAX_BOT_TO_BOT_TURNS_NO_PLAN : MAX_BOT_TO_BOT_TURNS;
  }

  // Treat expired or absent entries as zero.
  if (!entry || nowMs - entry.updatedAt > LOOP_COUNTER_TTL_MS) {
    return { allowed: true, count: 0, cap };
  }

  // v1.22.8 — user said stop. Peer-bot messages drop until next user message.
  if (entry.stopped) {
    return { allowed: false, count: entry.count, cap, reason: 'stopped' };
  }

  if (entry.count >= cap) {
    return { allowed: false, count: entry.count, cap, reason: 'cap' };
  }

  return { allowed: true, count: entry.count, cap };
}

/**
 * v1.23.4 — Mark or clear the sustained-banter flag on a thread. Called
 * from the gateway's user-message handler after running
 * SUSTAINED_BANTER_REGEX against the user's message text.
 *
 * Setting sustained=true raises the per-thread cap to 20. Any non-matching
 * user message resets the counter via resetBotToBotCounterOnUserMessage,
 * which deletes the entry entirely — including the sustained flag.
 */
export function markThreadSustained(
  threadKey: string,
  sustained: boolean,
  nowMs: number = Date.now(),
): void {
  const entry = counters.get(threadKey);
  if (!entry || nowMs - entry.updatedAt > LOOP_COUNTER_TTL_MS) {
    counters.set(threadKey, {
      count: 0,
      updatedAt: nowMs,
      stopped: false,
      sustained,
    });
    return;
  }
  counters.set(threadKey, { ...entry, sustained, updatedAt: nowMs });
}

/**
 * v1.23.4 — query helper for the current sustained-banter state of a thread.
 * Used by the BANTER overlay builder to decide whether to allow pass-the-ball.
 */
export function isThreadSustained(
  threadKey: string,
  nowMs: number = Date.now(),
): boolean {
  const entry = counters.get(threadKey);
  if (!entry || nowMs - entry.updatedAt > LOOP_COUNTER_TTL_MS) return false;
  return entry.sustained;
}

/**
 * Record a bot-to-bot turn for this thread. Call AFTER `checkBotToBotLoop`
 * returns `allowed: true`.
 *
 * Increments the counter and refreshes the TTL timestamp.
 */
export function recordBotToBotTurn(
  threadKey: string,
  nowMs: number = Date.now(),
): void {
  const entry = counters.get(threadKey);

  // If entry is absent or expired, start fresh at 1.
  if (!entry || nowMs - entry.updatedAt > LOOP_COUNTER_TTL_MS) {
    counters.set(threadKey, { count: 1, updatedAt: nowMs, stopped: false, sustained: false });
    return;
  }

  counters.set(threadKey, {
    count: entry.count + 1,
    updatedAt: nowMs,
    stopped: entry.stopped,
    sustained: entry.sustained,
  });
}

/**
 * v1.22.8 — User asked the team to stop. Mark the thread so peer-bot
 * messages drop at the gateway until any non-stop user message arrives
 * (which calls resetBotToBotCounterOnUserMessage and clears the entry).
 *
 * Stop-keyword detection lives in the gateway (regex on user text); this
 * helper only flips the flag.
 */
export function markThreadStopped(threadKey: string, nowMs: number = Date.now()): void {
  const entry = counters.get(threadKey);
  if (!entry || nowMs - entry.updatedAt > LOOP_COUNTER_TTL_MS) {
    counters.set(threadKey, { count: 0, updatedAt: nowMs, stopped: true, sustained: false });
    return;
  }
  // Stop also clears sustained — explicit stop > sustained-banter intent.
  counters.set(threadKey, { ...entry, stopped: true, sustained: false, updatedAt: nowMs });
}

/**
 * Regex matching user-message stop-signals. Used by the gateway to detect
 * "stop" / "drop it" / "enough" / "that's all" / "we're done" / "shut up"
 * / "quiet" / "pause" — case-insensitive, word-boundary anchored.
 *
 * Match policy: any presence of one of these phrases anywhere in the user's
 * message marks the thread stopped. We trust the user; false positives
 * here are recoverable (the next user message clears the flag).
 */
export const STOP_KEYWORDS_REGEX =
  /\b(?:stop|drop\s+it|enough|that(?:'|’)?s\s+all|we(?:'|’)?re\s+done|shut\s+up|quiet|pause)\b/i;

/**
 * Reset the bot-to-bot counter when a USER (non-bot) message arrives in a thread.
 *
 * Call this from the incoming-message handler BEFORE the activation gate, whenever
 * `isBotMessage(ctx) === false`. Human oversight resets the chain.
 */
export function resetBotToBotCounterOnUserMessage(
  threadKey: string,
): void {
  counters.delete(threadKey);
}

/**
 * Get the current counter value for a thread (for logging / diagnostics).
 * Returns 0 if no entry exists or if the entry is expired.
 */
export function getBotToBotCount(
  threadKey: string,
  nowMs: number = Date.now(),
): number {
  const entry = counters.get(threadKey);
  if (!entry || nowMs - entry.updatedAt > LOOP_COUNTER_TTL_MS) {
    return 0;
  }
  return entry.count;
}

/**
 * Reset ALL counters — used in tests to restore a clean state between test cases.
 * NOT for production use.
 */
export function _resetAllLoopCounters(): void {
  counters.clear();
}
