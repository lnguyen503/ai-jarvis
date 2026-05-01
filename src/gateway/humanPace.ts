/**
 * humanPace — slow group replies so they feel natural, not machine-fast (v1.22.2).
 *
 * Telegram bots can reply as soon as the LLM completes. For multi-bot demo
 * scenarios that's robotic — you see all 3 bots' replies appear within a
 * second of each other. Real conversations have pauses for typing.
 *
 * This module computes a per-reply delay and pulses the "typing…" indicator
 * during the wait. Total delay is content-length-scaled with jitter, capped
 * at a sane maximum.
 */

/** Per-reply pacing knobs. Defaults tuned for demo "feels-like-a-person" pace. */
export const HUMAN_PACE_DEFAULTS = {
  /** Always wait at least this long before sending. */
  baseMs: 1500,
  /** Add this many ms per character of the reply. ~40 wpm typing speed. */
  perCharMs: 25,
  /** Random ± jitter applied at the end. Avoids every reply being identical pace. */
  jitterMs: 500,
  /** Cap so very long replies don't take forever. */
  maxMs: 8000,
} as const;

export interface HumanPaceConfig {
  baseMs: number;
  perCharMs: number;
  jitterMs: number;
  maxMs: number;
}

/**
 * Compute a delay in ms that "feels like a person typed this."
 *
 * Pure function — testable. Uses the provided `random` callback (defaults to
 * Math.random) so tests can pin the jitter.
 */
export function humanPaceDelayMs(
  replyLen: number,
  cfg: HumanPaceConfig = HUMAN_PACE_DEFAULTS,
  random: () => number = Math.random,
): number {
  const baseAndContent = cfg.baseMs + replyLen * cfg.perCharMs;
  // Jitter is ± half the configured value, centered on 0.
  const jitter = (random() - 0.5) * cfg.jitterMs;
  const total = baseAndContent + jitter;
  return Math.max(0, Math.min(cfg.maxMs, Math.round(total)));
}

/**
 * Sleep with periodic typing-indicator pulses so Telegram keeps showing
 * "typing…" during long waits (Telegram clears the indicator after ~5s).
 *
 * @param totalMs       desired delay
 * @param pulseTyping   callback that re-sends chatAction:'typing'. Called
 *                      every 4s during the wait. Errors are swallowed —
 *                      typing-indicator failures should never break a turn.
 */
export async function sleepWithTyping(
  totalMs: number,
  pulseTyping: () => Promise<void>,
): Promise<void> {
  if (totalMs <= 0) return;
  // Send the first typing pulse immediately so the indicator is visible
  // even for short waits.
  await pulseTyping().catch(() => undefined);

  const pulseIntervalMs = 4000;
  let elapsed = 0;
  while (elapsed < totalMs) {
    const chunk = Math.min(pulseIntervalMs, totalMs - elapsed);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    elapsed += chunk;
    if (elapsed < totalMs) {
      await pulseTyping().catch(() => undefined);
    }
  }
}
